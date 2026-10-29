import { Injectable } from '@nestjs/common';
import { join } from 'node:path';

import { managedSettingsSchema } from './schema/agent-settings';

/** Shipped beside this file, and copied into every agent container. The hook starts the watchdog from beside itself. */
export const COMMAND_LIMIT_SOURCE = join(__dirname, 'command-limit.sh');
export const COMMAND_WATCHDOG_SOURCE = join(__dirname, 'command-watchdog.sh');
export const COMMAND_LIMIT_PATH = '/foundry/command-limit.sh';
export const COMMAND_WATCHDOG_PATH = '/foundry/command-watchdog.sh';

export const COMMAND_GRACE_MS = 60_000;

/** Claude Code's own limits for a Bash call. See the runner design, "Command limits". */
export const CLAUDE_DEFAULT_TIMEOUT_MS = 120_000;
export const CLAUDE_MAX_TIMEOUT_MS = 600_000;
export const CLAUDE_BACKGROUND_LIMIT_MS = 600_000;

/** Claude must accept the hook's raised timeout, which is the limit plus the grace plus 10 seconds. */
const CLAUDE_TIMEOUT_HEADROOM_MS = 20_000;

/** The hook runs with only this `PATH`, so the image check looks for its tools there. */
export const COMMAND_LIMIT_SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The line the watchdog appends to a stopped command's output, alone on its line. */
export const COMMAND_STOPPED_LINE =
  /^Swarmfoundry stopped this command, and every process it started, after \d+s: its limit of \d+s plus \d+s grace\.$/m;

/** Past the hook's worst case, bash retrying a fork for 15 seconds, as Claude runs a call whose hook timed out. */
const HOOK_TIMEOUT_SECONDS = 30;
const HOOK_FAILED = 'Swarmfoundry: the command limit hook failed, so the command did not run.';

/**
 * Adds the command limit to the agent's managed settings: a PreToolUse hook that has every Bash command killed once
 * it runs `COMMAND_GRACE_MS` past its limit. The limits come from Claude's timeout variables in the environment's
 * `env` and the operator's settings, and are fixed in the hook's command, so nothing the agent sets can raise them.
 */
@Injectable()
export class CommandLimitService {
  /** `settingsContent` is the operator's settings, already checked to be a JSON object. */
  managedSettings(settingsContent: string | undefined, env: Readonly<Record<string, string>>): string {
    const settings = this.settings(settingsContent);
    const { defaultMs, maxMs, backgroundMs } = this.limits(settingsContent, env);

    const command = [
      `/usr/bin/env -i PATH=${COMMAND_LIMIT_SEARCH_PATH} bash --norc --noprofile ${COMMAND_LIMIT_PATH}`,
      `${defaultMs} ${maxMs} ${backgroundMs} ${COMMAND_GRACE_MS}`,
      `|| { echo '${HOOK_FAILED}' >&2; exit 2; }`,
    ].join(' ');

    return JSON.stringify({
      ...settings,
      env: {
        ...settings.env,
        BASH_MAX_TIMEOUT_MS: String(maxMs + COMMAND_GRACE_MS + CLAUDE_TIMEOUT_HEADROOM_MS),
        // A prefix from a repo's settings would wrap the hook too, and could replace it.
        CLAUDE_CODE_SHELL_PREFIX: '',
      },
      // Claude's sandbox runs the command in a process namespace of its own, out of the watchdog's reach.
      sandbox: { ...settings.sandbox, enabled: false },
      // Claude drops every hook, this one included, where the managed settings disable them.
      disableAllHooks: false,
      hooks: {
        ...settings.hooks,
        PreToolUse: [
          ...(settings.hooks?.PreToolUse ?? []),
          { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] },
        ],
      },
    });
  }

  /** Fills the `{{defaultTimeout}}`, `{{backgroundTimeout}}` and `{{maxTimeout}}` in the runner's system prompt. */
  systemPrompt(template: string, settingsContent: string | undefined, env: Readonly<Record<string, string>>): string {
    const { defaultMs, maxMs, backgroundMs } = this.limits(settingsContent, env);

    return template
      .replaceAll('{{defaultTimeout}}', this.duration(defaultMs))
      .replaceAll('{{backgroundTimeout}}', this.duration(backgroundMs))
      .replaceAll('{{maxTimeout}}', this.duration(maxMs));
  }

  private settings(settingsContent: string | undefined) {
    return managedSettingsSchema.parse(settingsContent === undefined ? {} : JSON.parse(settingsContent));
  }

  private limits(settingsContent: string | undefined, env: Readonly<Record<string, string>>) {
    const variables = { ...env, ...this.settings(settingsContent).env };
    const defaultMs = this.positiveInt(variables.BASH_DEFAULT_TIMEOUT_MS) ?? CLAUDE_DEFAULT_TIMEOUT_MS;
    const maxMs = Math.max(this.positiveInt(variables.BASH_MAX_TIMEOUT_MS) ?? CLAUDE_MAX_TIMEOUT_MS, defaultMs);

    return { defaultMs, maxMs, backgroundMs: Math.max(CLAUDE_BACKGROUND_LIMIT_MS, defaultMs) };
  }

  private duration(ms: number): string {
    const seconds = Math.floor(ms / 1000);

    if (seconds % 60 !== 0) {
      return `${seconds} seconds`;
    }

    return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
  }

  /** Mirrors Claude's reading of the variables, which ignores a value that is not a positive integer. */
  private positiveInt(value: unknown): number | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }

    const parsed = Number.parseInt(String(value).trim(), 10);

    return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
  }
}
