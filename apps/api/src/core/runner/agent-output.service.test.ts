import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';

import {
  AgentOutputService,
  MAX_BATCH_LINES,
  MAX_LINE_LENGTH,
  SECRET_OVERLAP,
  STDERR_TAIL_LINES,
} from './agent-output.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { REDACTED, SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';
import type { TaskService } from '@/core/task/task.service';

import { RunConfigError } from './run-config.error';
import type { IResolvedAgent } from '@/core/foundry-config/types/foundry-config.types';

const AGENT_TOKEN = 'sk-ant-oat-agent-token';
const CONFIG_SECRET = 'glpat-config-secret';

const agent = (enabledPlugins?: Record<string, unknown>): IResolvedAgent => ({
  name: 'claude',
  type: 'claude',
  auth: 'oauth',
  token: AGENT_TOKEN,
  model: 'haiku',
  settings:
    enabledPlugins === undefined
      ? undefined
      : { path: '/config/settings.json', content: JSON.stringify({ enabledPlugins }) },
});

const line = (event: unknown) => Buffer.from(`${JSON.stringify(event)}\n`);

const init = (...sources: string[]) => ({
  type: 'system',
  subtype: 'init',
  plugins: sources.map(source => ({ name: source.split('@')[0], source })),
});

describe('AgentOutputService', () => {
  let stored: RunTranscriptLine[][];
  let appendTranscriptLines: Mock<(lines: RunTranscriptLine[]) => Promise<void>>;
  let service: AgentOutputService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    stored = [];
    appendTranscriptLines = vi.fn((lines: RunTranscriptLine[]) => {
      stored.push(lines);

      return Promise.resolve();
    });

    const secretRedactionService = new SecretRedactionService();
    const foundryConfigService = {
      redactText: (text: string, extra: readonly string[] = []) =>
        secretRedactionService.redactText(text, [CONFIG_SECRET, ...extra]),
    } as unknown as FoundryConfigService;

    service = new AgentOutputService(foundryConfigService, { appendTranscriptLines } as unknown as TaskService);
  });

  const storedLines = () => stored.flat().map(row => [row.runId, row.lineNumber, row.line]);

  describe('transcript', () => {
    it('stores each stdout line in order, numbered, joining lines split across chunks', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('{"a":1}\n{"b"'));
      service.writeStdout(output, Buffer.from(':2}\r\n{"c":3}'));
      await service.finish(output);

      expect(storedLines()).toEqual([
        [9, 1, '{"a":1}'],
        [9, 2, '{"b":2}'],
        [9, 3, '{"c":3}'],
      ]);
    });

    it('stores only the lines past those already stored, but reads every line for events', async () => {
      const output = service.create(4, 9, agent({ 'dev@acme': true }), 2);

      service.writeStdout(output, line(init('dev@acme')));
      service.writeStdout(output, line({ type: 'assistant' }));
      service.writeStdout(output, line({ type: 'result', subtype: 'success' }));
      await service.finish(output);

      expect(storedLines()).toEqual([[9, 3, '{"type":"result","subtype":"success"}']]);
      expect(service.hasInit(output)).toBe(true);
      expect(output.result).toBe('{"type":"result","subtype":"success"}');
    });

    it('keeps a multi-byte character split across chunks whole', async () => {
      const output = service.create(4, 9, agent());
      const bytes = Buffer.from('café\n');

      service.writeStdout(output, bytes.subarray(0, 4));
      service.writeStdout(output, bytes.subarray(4));
      await service.finish(output);

      expect(storedLines()).toEqual([[9, 1, 'café']]);
    });

    it('redacts config secrets and the agent token, raw and JSON-escaped, before storing', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, line({ text: `${CONFIG_SECRET} and ${AGENT_TOKEN}` }));
      await service.finish(output);

      expect(storedLines()).toEqual([[9, 1, `{"text":"${REDACTED} and ${REDACTED}"}`]]);
    });

    it('writes one batch at a time, so later lines never overtake earlier ones', async () => {
      let release: () => void = () => undefined;

      appendTranscriptLines.mockImplementationOnce((lines: RunTranscriptLine[]) => {
        stored.push(lines);

        return new Promise<void>(resolve => {
          release = resolve;
        });
      });

      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('1\n'));
      service.writeStdout(output, Buffer.from('2\n3\n'));

      expect(appendTranscriptLines).toHaveBeenCalledTimes(1);

      release();
      await service.finish(output);

      expect(stored.map(batch => batch.map(row => row.lineNumber))).toEqual([[1], [2, 3]]);
    });

    it(`caps a batch at ${MAX_BATCH_LINES} lines`, async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('x\n'.repeat(MAX_BATCH_LINES + 1)));
      await service.finish(output);

      expect(stored.map(batch => batch.length)).toEqual([1, MAX_BATCH_LINES]);
    });

    it('stores an over-long line in pieces', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('a'.repeat(MAX_LINE_LENGTH + SECRET_OVERLAP + 5)));
      await service.finish(output);

      expect(stored.flat().map(row => row.line.length)).toEqual([MAX_LINE_LENGTH, SECRET_OVERLAP + 5]);
    });

    it('redacts a secret that straddles the cut of an over-long line', async () => {
      const output = service.create(4, 9, agent());
      const prefix = 'a'.repeat(MAX_LINE_LENGTH - 4);

      service.writeStdout(output, Buffer.from(`${prefix}${AGENT_TOKEN}${'b'.repeat(SECRET_OVERLAP)}`));
      await service.finish(output);

      const text = stored
        .flat()
        .map(row => row.line)
        .join('');

      expect(text).not.toContain(AGENT_TOKEN.slice(4));
      expect(text).toContain(REDACTED);
    });

    it('strips NUL characters, which Postgres text cannot hold', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('a\u0000b\n'));
      await service.finish(output);

      expect(storedLines()).toEqual([[9, 1, 'ab']]);
    });

    it('leaves a line without its newline out of a flush', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('done\npart'));
      await service.flush(output);

      expect(storedLines()).toEqual([[9, 1, 'done']]);
    });

    it('drops the rest of the transcript after a failed write, and records why', async () => {
      appendTranscriptLines.mockRejectedValueOnce(new Error(`connection lost ${CONFIG_SECRET}`));

      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from('1\n'));
      await service.flush(output);
      service.writeStdout(output, Buffer.from('2\n'));
      await service.finish(output);

      expect(output.writeError).toContain('connection lost');
      expect(appendTranscriptLines).toHaveBeenCalledTimes(1);
    });
  });

  describe('events', () => {
    it('keeps the last result line, redacted', async () => {
      const output = service.create(4, 9, agent());

      service.writeStdout(output, line({ type: 'result', subtype: 'success', result: `done ${AGENT_TOKEN}` }));
      await service.finish(output);

      expect(output.result).toBe(`{"type":"result","subtype":"success","result":"done ${REDACTED}"}`);
    });

    it('reports nothing about plugins before system/init', () => {
      const output = service.create(4, 9, agent({ 'development@acme': true }));

      service.writeStdout(output, line({ type: 'system', subtype: 'plugin_install', status: 'started' }));

      expect(service.hasInit(output)).toBe(false);
      expect(service.pluginFailure(output)).toBeNull();
    });

    it('passes when every enabled plugin loaded, ignoring disabled ones', () => {
      const output = service.create(4, 9, agent({ 'development@acme': true, 'off@acme': false }));

      service.writeStdout(output, line(init('development@acme', 'telemetry@builtin')));

      expect(service.hasInit(output)).toBe(true);
      expect(service.pluginFailure(output)).toBeNull();
    });

    it('fails when an enabled plugin is missing from system/init', () => {
      const output = service.create(4, 9, agent({ 'development@acme': true, 'review@acme': true }));

      service.writeStdout(output, line(init('development@acme')));

      expect(service.pluginFailure(output)).toBe("Claude's plugins failed: enabled plugin review@acme did not load");
    });

    it('fails on a failed plugin install, even with every plugin loaded', () => {
      const output = service.create(4, 9, agent({}));

      service.writeStdout(
        output,
        line({ type: 'system', subtype: 'plugin_install', status: 'failed', name: 'acme', error: 'clone failed' })
      );
      service.writeStdout(output, line(init()));

      expect(service.pluginFailure(output)).toBe("Claude's plugins failed: installing acme failed: clone failed");
    });

    it('checks plugins against the raw line, so a short secret inside a plugin name cannot fail it', async () => {
      const secretRedactionService = new SecretRedactionService();
      const masking = {
        redactText: (text: string, extra: readonly string[] = []) =>
          secretRedactionService.redactText(text, ['acme', 'true', ...extra]),
      } as unknown as FoundryConfigService;
      const strict = new AgentOutputService(masking, { appendTranscriptLines } as unknown as TaskService);
      const output = strict.create(4, 9, agent({ 'development@acme': true }));

      strict.writeStdout(output, line(init('development@acme')));
      await strict.finish(output);

      expect(strict.pluginFailure(output)).toBeNull();
      expect(stored.flat()[0].line).toContain(`development@${REDACTED}`);
    });

    it('redacts the error of a failed install', () => {
      const output = service.create(4, 9, agent({}));

      service.writeStdout(
        output,
        line({
          type: 'system',
          subtype: 'plugin_install',
          status: 'failed',
          name: 'acme',
          error: `401 ${AGENT_TOKEN}`,
        })
      );
      service.writeStdout(output, line(init()));

      expect(service.pluginFailure(output)).toBe(`Claude's plugins failed: installing acme failed: 401 ${REDACTED}`);
    });

    it('refuses settings whose enabledPlugins is not an object', () => {
      const broken = { ...agent(), settings: { path: '/config/settings.json', content: '{"enabledPlugins":[]}' } };

      expect(() => service.create(4, 9, broken)).toThrow('/config/settings.json');
      expect(() => service.create(4, 9, broken)).toThrow(RunConfigError);
    });
  });

  describe('command limit', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const bashCall = (id: string, command: string) =>
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n`;
    const toolResult = (id: string, content: string) =>
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":${JSON.stringify(id)},"content":${JSON.stringify(content)}}]}}\n`;
    const killed = (id: string, at = Date.now()) =>
      `Swarmfoundry: the command limit stopped tool call ${id} at ${at}.\n`;

    it('logs a kill from stderr once, with its task, run and redacted command, and keeps it out of the tail', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from(bashCall('toolu_1', `glab mr view --token ${AGENT_TOKEN}`)));
      service.writeStderr(output, Buffer.from(killed('toolu_1')));
      await service.finish(output);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { taskId: 4, runId: 9, toolUseId: 'toolu_1', command: `glab mr view --token ${REDACTED}` },
        expect.stringContaining('The command limit stopped an agent command')
      );
      expect(service.stderrTail(output)).toBeNull();
      expect(output.bashCommands.size).toBe(0);
    });

    it('logs the kill of a background call, whose result came before it', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStdout(output, Buffer.from(bashCall('toolu_1', 'npm run dev')));
      service.writeStdout(output, Buffer.from(toolResult('toolu_1', 'Command running in background with ID: b1')));
      service.writeStderr(output, Buffer.from(killed('toolu_1')));
      await service.finish(output);

      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm run dev' }), expect.any(String));
    });

    it('logs a kill appended to unfinished stderr from Claude, keeping that stderr redacted in the tail', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStderr(output, Buffer.from(`warning ${AGENT_TOKEN}: ${killed('toolu_2')}${killed('')}`));
      await service.finish(output);

      expect(service.stderrTail(output)).toBe(`warning ${REDACTED}: `);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: 'toolu_2', command: null }),
        expect.any(String)
      );
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: '', command: null }), expect.any(String));
    });

    it('redacts a long command before cutting it, so no token is logged in part', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());
      const command = `${'x'.repeat(190)} ${AGENT_TOKEN}`;

      service.writeStdout(output, Buffer.from(bashCall('toolu_1', command)));
      service.writeStderr(output, Buffer.from(killed('toolu_1')));
      await service.finish(output);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ command: `${'x'.repeat(190)} ${REDACTED}`.slice(0, 200) }),
        expect.any(String)
      );
    });

    it('logs nothing for a stopped result, or for stderr that only quotes the kill line', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());
      const stopped =
        'Exit code 1\nready\n\nSwarmfoundry stopped this command, and every process it started, after 180s: its limit of 120s plus 60s grace.';

      service.writeStdout(output, Buffer.from(bashCall('toolu_1', 'make') + toolResult('toolu_1', stopped)));
      service.writeStderr(output, Buffer.from(`quoted '${killed('toolu_1').trim()}'\n`));
      await service.finish(output);

      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['carries a token as its id', killed(AGENT_TOKEN).trim()],
      ['carries a token after a kill line as its id', `note ${killed(AGENT_TOKEN).trim()}`],
      ['carries an id not in the tool use shape', killed('toolu_1-x').trim()],
      ['carries an id without the toolu_ prefix', killed('call_1').trim()],
    ])('logs no kill for stderr that %s, and keeps it redacted in the tail', async (_case, line) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStderr(output, Buffer.from(`${line}\n`));
      await service.finish(output);

      expect(warn).not.toHaveBeenCalled();
      expect(service.stderrTail(output)).toBe(line.replaceAll(AGENT_TOKEN, REDACTED));
      expect(service.stderrTail(output)).not.toContain(AGENT_TOKEN);
    });

    it.each(['toolu_bdrk_01Vz7cmp4URWqR3dnm82Sh4m', 'toolu_vrtx_01Vz7cmp4URWqR3dnm82Sh4m'])(
      'logs the kill of a Bedrock or Vertex call %s with its command',
      async id => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const output = service.create(4, 9, agent());

        service.writeStdout(output, Buffer.from(bashCall(id, 'make')));
        service.writeStderr(output, Buffer.from(killed(id)));
        await service.finish(output);

        expect(warn).toHaveBeenCalledWith({ taskId: 4, runId: 9, toolUseId: id, command: 'make' }, expect.any(String));
        expect(service.stderrTail(output)).toBeNull();
      }
    );

    it('keeps every blank line Claude wrote to stderr, around a kill line too', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStderr(output, Buffer.from('first\n\nsecond\n'));
      service.writeStderr(output, Buffer.from(`\n${killed('toolu_1')}`));
      service.writeStderr(output, Buffer.from('\nthird\n\n'));
      await service.finish(output);

      expect(output.stderrTail).toEqual(['first', '', 'second', '', '', 'third', '']);
    });

    it('redacts a secret that fits the tool use id shape before logging the id', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const secretRedactionService = new SecretRedactionService();
      const masking = {
        redactText: (text: string, extra: readonly string[] = []) =>
          secretRedactionService.redactText(text, ['Base62Secret', ...extra]),
      } as unknown as FoundryConfigService;
      const strict = new AgentOutputService(masking, { appendTranscriptLines } as unknown as TaskService);
      const output = strict.create(4, 9, agent());

      strict.writeStderr(output, Buffer.from(killed('toolu_Base62Secret')));
      await strict.finish(output);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: `toolu_${REDACTED}` }),
        expect.any(String)
      );
    });

    it('names the call in a stream captured from Claude Code', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent());

      service.writeStdout(output, readFileSync(join(__dirname, 'fixtures', 'claude-code-2.1.312.stream.jsonl')));
      service.writeStderr(output, Buffer.from(killed('toolu_01Vz7cmp4URWqR3dnm82Sh4m')));
      await service.finish(output);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { taskId: 4, runId: 9, toolUseId: 'toolu_01Vz7cmp4URWqR3dnm82Sh4m', command: 'echo waiting; sleep 30' },
        expect.any(String)
      );
    });

    it('logs no kill a reattach replays from before it began reading, but logs one after, with no line since', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = service.create(4, 9, agent(), 2);

      service.writeStdout(output, Buffer.from(bashCall('toolu_1', 'make') + bashCall('toolu_2', 'npm test')));
      service.writeStderr(output, Buffer.from(killed('toolu_1', output.readSince - 1)));
      service.writeStderr(output, Buffer.from(killed('toolu_2', output.readSince)));
      await service.finish(output);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { taskId: 4, runId: 9, toolUseId: 'toolu_2', command: 'npm test' },
        expect.any(String)
      );
    });
  });

  describe('stderr', () => {
    it('keeps a redacted tail, not stored as transcript', async () => {
      const output = service.create(4, 9, agent());

      service.writeStderr(output, Buffer.from(`fatal: ${AGENT_TOKEN}\nlast`));
      await service.finish(output);

      expect(service.stderrTail(output)).toBe(`fatal: ${REDACTED}\nlast`);
      expect(appendTranscriptLines).not.toHaveBeenCalled();
    });

    it(`keeps only the last ${STDERR_TAIL_LINES} lines`, () => {
      const output = service.create(4, 9, agent());

      service.writeStderr(
        output,
        Buffer.from(Array.from({ length: STDERR_TAIL_LINES + 5 }, (_, i) => `${i}\n`).join(''))
      );

      expect(output.stderrTail).toHaveLength(STDERR_TAIL_LINES);
      expect(output.stderrTail[0]).toBe('5');
    });

    it('is null when the container wrote none', () => {
      expect(service.stderrTail(service.create(4, 9, agent()))).toBeNull();
    });
  });
});
