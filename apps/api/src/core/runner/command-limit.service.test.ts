import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RUNNER_SYSTEM_PROMPT_SOURCE } from './agent-runner.service';
import {
  COMMAND_GRACE_MS,
  COMMAND_LIMIT_PATH,
  COMMAND_WATCHDOG_PATH,
  COMMAND_WATCHDOG_SOURCE,
  CommandLimitService,
} from './command-limit.service';

const service = new CommandLimitService();

const settingsOf = (settingsContent?: string, env: Record<string, string> = {}) =>
  JSON.parse(service.managedSettings(settingsContent, env)) as {
    env: Record<string, unknown>;
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
    [key: string]: unknown;
  };

/** The limits fixed in the hook's command: default, max, background and grace. */
const limitsOf = (settingsContent?: string, env: Record<string, string> = {}) => {
  const hook = settingsOf(settingsContent, env).hooks.PreToolUse.at(-1)?.hooks[0];
  const match = new RegExp(`${COMMAND_LIMIT_PATH} (\\d+) (\\d+) (\\d+) (\\d+) `).exec(hook?.command ?? '');

  return match?.slice(1).map(Number);
};

describe('CommandLimitService', () => {
  it("adds a Bash hook that fails closed, with Claude's own limits and the grace", () => {
    const [entry] = settingsOf().hooks.PreToolUse;

    expect(entry.matcher).toBe('Bash');
    expect(entry.hooks[0]?.command).toMatch(/^\/usr\/bin\/env -i PATH=\S+ bash --norc --noprofile /);
    expect(entry.hooks[0]?.command).toMatch(/\|\| \{ echo '.+' >&2; exit 2; \}$/);
    expect(entry.hooks[0]?.timeout).toBe(30);
    expect(limitsOf()).toEqual([120_000, 600_000, 600_000, COMMAND_GRACE_MS]);
  });

  it("raises Claude's maximum above the hook's, so Claude accepts the raised timeout", () => {
    expect(settingsOf().env.BASH_MAX_TIMEOUT_MS).toBe(String(600_000 + COMMAND_GRACE_MS + 20_000));
    expect(settingsOf(JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: '900000' } })).env.BASH_MAX_TIMEOUT_MS).toBe(
      String(900_000 + COMMAND_GRACE_MS + 20_000)
    );
  });

  it.runIf(process.platform === 'linux')('blocks the call when the hook cannot run', () => {
    const hook = settingsOf().hooks.PreToolUse.at(-1)?.hooks[0];
    const run = spawnSync('sh', ['-c', hook?.command ?? ''], { input: '{}', encoding: 'utf8' });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('the command limit hook failed');
  });

  it('ships the watchdog beside the hook, where the hook starts it', () => {
    expect(COMMAND_WATCHDOG_PATH).toBe(join(dirname(COMMAND_LIMIT_PATH), basename(COMMAND_WATCHDOG_SOURCE)));
  });

  it('clears any shell prefix, which would wrap the hook too', () => {
    expect(
      settingsOf(JSON.stringify({ env: { CLAUDE_CODE_SHELL_PREFIX: '/opt/wrap' } })).env.CLAUDE_CODE_SHELL_PREFIX
    ).toBe('');
  });

  it.each([
    [undefined, { enabled: false }],
    [
      JSON.stringify({ sandbox: { enabled: true, network: { allowLocalBinding: true } } }),
      { enabled: false, network: { allowLocalBinding: true } },
    ],
  ])("turns Claude's sandbox off, which would hide the command from the watchdog, from %s", (settings, sandbox) => {
    expect(settingsOf(settings).sandbox).toEqual(sandbox);
  });

  it("keeps hooks on, which an operator's disableAllHooks would turn off with the limit", () => {
    expect(settingsOf(JSON.stringify({ disableAllHooks: true })).disableAllHooks).toBe(false);
  });

  it("reads the limits from the environment's env, with the settings' env over it", () => {
    const env = { BASH_DEFAULT_TIMEOUT_MS: '300000', BASH_MAX_TIMEOUT_MS: '900000' };
    const settings = JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: 1_200_000 } });

    expect(limitsOf(undefined, env)).toEqual([300_000, 900_000, 600_000, COMMAND_GRACE_MS]);
    expect(limitsOf(settings, env)).toEqual([300_000, 1_200_000, 600_000, COMMAND_GRACE_MS]);
  });

  it('keeps the maximum and the background limit at least the default, as Claude does', () => {
    expect(limitsOf(undefined, { BASH_DEFAULT_TIMEOUT_MS: '900000', BASH_MAX_TIMEOUT_MS: '300000' })).toEqual([
      900_000,
      900_000,
      900_000,
      COMMAND_GRACE_MS,
    ]);
  });

  it('ignores a value Claude would ignore', () => {
    expect(limitsOf(undefined, { BASH_DEFAULT_TIMEOUT_MS: 'soon', BASH_MAX_TIMEOUT_MS: '-5' })).toEqual([
      120_000,
      600_000,
      600_000,
      COMMAND_GRACE_MS,
    ]);
  });

  it.each([
    [{}, '2 minutes, 10 minutes, 10 minutes'],
    [{ BASH_DEFAULT_TIMEOUT_MS: '90500', BASH_MAX_TIMEOUT_MS: '60000' }, '90 seconds, 10 minutes, 90 seconds'],
  ])("fills the runner's system prompt with the limits from %j", (env, limits) => {
    expect(service.systemPrompt('{{defaultTimeout}}, {{backgroundTimeout}}, {{maxTimeout}}', undefined, env)).toBe(
      limits
    );
  });

  it("leaves no placeholder unfilled in the runner's system prompt", () => {
    expect(service.systemPrompt(readFileSync(RUNNER_SYSTEM_PROMPT_SOURCE, 'utf8'), undefined, {})).not.toContain('{{');
  });

  it("keeps the operator's settings and hooks, adding its own after them", () => {
    const operatorHook = { matcher: 'Edit', hooks: [{ type: 'command', command: 'true' }] };
    const settings = settingsOf(
      JSON.stringify({
        enabledPlugins: { 'development@acme': true },
        env: { OTHER: '1' },
        hooks: { PreToolUse: [operatorHook], Stop: [] },
      })
    );

    expect(settings.enabledPlugins).toEqual({ 'development@acme': true });
    expect(settings.env.OTHER).toBe('1');
    expect(settings.hooks).toMatchObject({ Stop: [] });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0]).toEqual(operatorHook);
  });
});
