import { Injectable, Logger } from '@nestjs/common';
import { StringDecoder } from 'node:string_decoder';

import { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';

import { COMMAND_STOPPED_LINE } from './command-limit.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskService } from '@/core/task/task.service';

import { RunConfigError } from './run-config.error';
import type { IAgentOutput } from './runner.types';
import { agentSettingsSchema } from './schema/agent-settings';
import {
  assistantSchema,
  bashToolUseSchema,
  pluginInstallSchema,
  resultSchema,
  systemInitSchema,
  toolResultSchema,
  userSchema,
} from './schema/stream-json';
import type { IResolvedAgent } from '@/core/foundry-config/foundry-config.types';

/** A line longer than this is stored in pieces, so output without newlines cannot grow without bound. */
export const MAX_LINE_LENGTH = 4 * 1024 * 1024;

/** An over-long line is cut only this far from its unread end, so no secret of up to this length straddles a cut. */
export const SECRET_OVERLAP = 64 * 1024;

export const MAX_BATCH_LINES = 500;
export const MAX_BATCH_LENGTH = 8 * 1024 * 1024;

export const STDERR_TAIL_LINES = 100;
const STDERR_LINE_MAX_LENGTH = 2000;

const ERROR_DETAIL_MAX_LENGTH = 500;
const LOGGED_COMMAND_LENGTH = 200;

/**
 * Reads one run's output. Each stdout line is redacted, stored in order as a transcript line, and read for the
 * stream-json events the runner judges by. Stderr keeps only a redacted tail for the failure record.
 */
@Injectable()
export class AgentOutputService {
  private readonly logger = new Logger(AgentOutputService.name);

  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly taskService: TaskService
  ) {}

  /** Throws when the agent's settings name `enabledPlugins` in a shape Claude would not read either. */
  create(runId: number, agent: IResolvedAgent, storedLineCount = 0): IAgentOutput {
    return {
      runId,
      storedLineCount,
      extraSecrets: [agent.token],
      enabledPlugins: this.enabledPlugins(agent),

      stdoutDecoder: new StringDecoder('utf8'),
      stdoutPartial: '',
      stderrDecoder: new StringDecoder('utf8'),
      stderrPartial: '',

      lineCount: 0,
      pendingLines: [],
      writing: null,
      writeError: null,

      loadedPlugins: null,
      failedInstalls: [],
      result: null,
      usage: null,

      stderrTail: [],

      bashCommands: new Map(),
    };
  }

  writeStdout(output: IAgentOutput, chunk: Buffer): void {
    output.stdoutPartial = this.splitLines(output, output.stdoutPartial + output.stdoutDecoder.write(chunk), line =>
      this.readStdoutLine(output, line)
    );
  }

  writeStderr(output: IAgentOutput, chunk: Buffer): void {
    output.stderrPartial = this.splitLines(output, output.stderrPartial + output.stderrDecoder.write(chunk), line =>
      this.readStderrLine(output, line)
    );
  }

  /** Takes in a last line without a newline, and waits until every line is stored or a write failed. */
  async finish(output: IAgentOutput): Promise<void> {
    const stdout = output.stdoutPartial + output.stdoutDecoder.end();
    const stderr = output.stderrPartial + output.stderrDecoder.end();

    output.stdoutPartial = '';
    output.stderrPartial = '';

    if (stdout !== '') {
      this.readStdoutLine(output, stdout);
    }

    if (stderr !== '') {
      this.readStderrLine(output, stderr);
    }

    await this.flush(output);
  }

  /** Waits for the lines read so far to be stored, leaving out any line still without its newline. */
  async flush(output: IAgentOutput): Promise<void> {
    while (output.writing !== null) {
      await output.writing;
    }
  }

  /** Null until `system/init` arrives, then whether every enabled plugin loaded and every install succeeded. */
  pluginFailure(output: IAgentOutput): string | null {
    if (output.loadedPlugins === null) {
      return null;
    }

    const loaded = new Set(output.loadedPlugins);
    const missing = output.enabledPlugins.filter(plugin => !loaded.has(plugin));
    const reasons = [...output.failedInstalls, ...missing.map(plugin => `enabled plugin ${plugin} did not load`)];

    return reasons.length === 0 ? null : `Claude's plugins failed: ${reasons.join('; ')}`;
  }

  hasInit(output: IAgentOutput): boolean {
    return output.loadedPlugins !== null;
  }

  stderrTail(output: IAgentOutput): string | null {
    return output.stderrTail.length === 0 ? null : output.stderrTail.join('\n');
  }

  private enabledPlugins(agent: IResolvedAgent): string[] {
    if (agent.settings === undefined) {
      return [];
    }

    const parsed = agentSettingsSchema.safeParse(JSON.parse(agent.settings.content));

    if (!parsed.success) {
      throw new RunConfigError(`The settings in ${agent.settings.path} hold an enabledPlugins that is not an object`);
    }

    return Object.entries(parsed.data.enabledPlugins)
      .filter(([, enabled]) => enabled !== false)
      .map(([plugin]) => plugin);
  }

  /**
   * Hands each complete line to `read` and returns the rest. An over-long rest is redacted whole, then read in pieces
   * of `MAX_LINE_LENGTH`, keeping `SECRET_OVERLAP` back.
   */
  private splitLines(output: IAgentOutput, text: string, read: (line: string) => void): string {
    let start = 0;
    let newline = text.indexOf('\n', start);

    while (newline !== -1) {
      read(text.slice(start, newline).replace(/\r$/, ''));
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }

    let rest = text.slice(start);

    if (rest.length < MAX_LINE_LENGTH + SECRET_OVERLAP) {
      return rest;
    }

    rest = this.redact(output, rest);

    while (rest.length >= MAX_LINE_LENGTH + SECRET_OVERLAP) {
      read(rest.slice(0, MAX_LINE_LENGTH));
      rest = rest.slice(MAX_LINE_LENGTH);
    }

    return rest;
  }

  /** Reads events from the raw line, so a short secret masked inside a plugin name cannot fail the plugin check. */
  private readStdoutLine(output: IAgentOutput, raw: string): void {
    const text = raw.replaceAll('\u0000', '');
    const line = this.redact(output, text);

    output.lineCount++;

    // After a failed write the rest is dropped, so no later line lands without the ones before it.
    if (output.writeError === null && output.lineCount > output.storedLineCount) {
      output.pendingLines.push(new RunTranscriptLine({ runId: output.runId, lineNumber: output.lineCount, line }));

      output.writing ??= this.writePending(output);
    }

    this.readEvent(output, text, line);
  }

  private readStderrLine(output: IAgentOutput, raw: string): void {
    const line = this.redact(output, raw);

    output.stderrTail.push(line.slice(0, STDERR_LINE_MAX_LENGTH));

    if (output.stderrTail.length > STDERR_TAIL_LINES) {
      output.stderrTail.shift();
    }
  }

  /** Parses `raw` and keeps only redacted text: `line`, or a redacted error. */
  private readEvent(output: IAgentOutput, raw: string, line: string): void {
    const event = this.parseJson(raw);

    if (event === undefined) {
      return;
    }

    const init = systemInitSchema.safeParse(event);

    if (init.success) {
      output.loadedPlugins = init.data.plugins.flatMap(plugin => (plugin.source === undefined ? [] : [plugin.source]));

      return;
    }

    const install = pluginInstallSchema.safeParse(event);

    if (install.success && install.data.status === 'failed') {
      const detail = (install.data.error ?? 'no error given').slice(0, ERROR_DETAIL_MAX_LENGTH);
      const failure = `installing ${install.data.name ?? 'a marketplace'} failed: ${detail}`;

      output.failedInstalls.push(this.redact(output, failure));

      return;
    }

    const assistant = assistantSchema.safeParse(event);

    if (assistant.success) {
      for (const block of assistant.data.message.content) {
        const call = bashToolUseSchema.safeParse(block);

        if (call.success) {
          const command = this.redact(output, call.data.input.command).slice(0, LOGGED_COMMAND_LENGTH);

          output.bashCommands.set(call.data.id, command);
        }
      }

      return;
    }

    const user = userSchema.safeParse(event);

    if (user.success) {
      for (const block of user.data.message.content) {
        this.readToolResult(output, block);
      }

      return;
    }

    const result = resultSchema.safeParse(event);

    if (result.success) {
      const { num_turns: turns, total_cost_usd: costUsd, usage } = result.data;

      output.result = line;
      output.usage = {
        turns: turns ?? null,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
        costUsd: costUsd ?? null,
      };
    }
  }

  /** Logs a Bash call the command limit stopped, once: a reattach replays lines already stored. */
  private readToolResult(output: IAgentOutput, block: unknown): void {
    const result = toolResultSchema.safeParse(block);

    if (!result.success) {
      return;
    }

    const { tool_use_id: toolUseId, content } = result.data;
    const command = output.bashCommands.get(toolUseId);

    output.bashCommands.delete(toolUseId);

    if (command !== undefined && COMMAND_STOPPED_LINE.test(content) && output.lineCount > output.storedLineCount) {
      this.logger.warn(
        { runId: output.runId, toolUseId, command },
        'readToolResult(): The command limit stopped an agent command'
      );
    }
  }

  /** One writer per run, so lines land in order. Call with a line pending, so it awaits before clearing `writing`. */
  private async writePending(output: IAgentOutput): Promise<void> {
    try {
      while (output.pendingLines.length > 0) {
        await this.taskService.appendTranscriptLines(this.takeBatch(output));
      }
    } catch (error) {
      output.writeError = error instanceof Error ? error.message : 'unknown error';
      output.pendingLines = [];

      this.logger.error(
        { runId: output.runId, error: this.foundryConfigService.redactText(output.writeError) },
        'writePending(): Failed to store transcript lines, so the rest of the transcript is dropped'
      );
    } finally {
      output.writing = null;
    }
  }

  private takeBatch(output: IAgentOutput): RunTranscriptLine[] {
    let count = 0;
    let length = 0;

    while (count < output.pendingLines.length && count < MAX_BATCH_LINES) {
      length += output.pendingLines[count].line.length;
      count++;

      if (length >= MAX_BATCH_LENGTH) {
        break;
      }
    }

    return output.pendingLines.splice(0, count);
  }

  private redact(output: IAgentOutput, text: string): string {
    return this.foundryConfigService.redactText(text, output.extraSecrets);
  }

  private parseJson(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }
}
