import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_LIMIT_SOURCE, COMMAND_STOPPED_LINE, COMMAND_WATCHDOG_SOURCE } from './command-limit.service';

const REASON =
  'Swarmfoundry stopped this command, and every process it started, after 2s: its limit of 1s plus 1s grace.';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', `claude-code-2.1.312.${name}`), 'utf8');

const marker = (callId: string, watchdogPid: number) =>
  `\\builtin export SWARMFOUNDRY_CALL=${callId}; { \\builtin echo $$ >> /proc/${watchdogPid}/fd/9; } 2> /dev/null; `;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Claude's process: the parent of the session leader of the process given, or the leader where it has none. */
const parentOfSession = (pid: number | 'self') => {
  const fields = (path: string) => readFileSync(path, 'utf8').split(') ')[1]?.split(' ') ?? [];
  const session = Number(fields(`/proc/${pid}/stat`)[3]);

  return Number(fields(`/proc/${session}/stat`)[1]) || session;
};

/**
 * Starts `command` in a shell shaped as Claude Code 2.1.312 starts one, from its captured arguments: in a session of
 * its own, its output appended to `output`, and a line after the command. A heredoc command keeps Claude's stdin.
 */
const startShell = (command: string, output: string, cwdFile: string, heredoc = false, env = process.env) => {
  const [shell, flag, line] = fixture('shell-cmdline')
    .split('\0')
    .filter(arg => arg !== '');
  const quoted = `'${command.replaceAll("'", `'"'"'`)}'`;
  const script = line.replace(
    /eval '.*'(?: < \/dev\/null)? && pwd -P >\| \S+$/,
    () => `eval ${quoted}${heredoc ? '' : ' < /dev/null'} && pwd -P >| ${cwdFile}`
  );

  if (script === line) {
    throw new Error('The captured shell has changed shape');
  }

  const fd = openSync(output, 'a');
  const child = spawn(shell, [flag, script], { detached: true, stdio: ['pipe', fd, fd], env });

  closeSync(fd);

  return child;
};

describe.runIf(process.platform === 'linux')('command-limit.sh', () => {
  let bin: string;

  beforeEach(() => {
    // A setsid that records how the hook starts the watchdog, starts nothing and answers as the watchdog would.
    bin = mkdtempSync(join(tmpdir(), 'command-limit-'));
    writeFileSync(
      join(bin, 'setsid'),
      `#!/bin/sh\nprintf '%s\\n' "$SWARMFOUNDRY_REASON" "$@" > ${bin}/watchdog\necho 4242\n`
    );
    chmodSync(join(bin, 'setsid'), 0o755);
  });

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** Runs the hook with a default of 120 s, a maximum of 600 s, a background limit of 900 s and a grace of 60 s. */
  const runHook = (input: string) => {
    const output = execFileSync('bash', [COMMAND_LIMIT_SOURCE, '120000', '600000', '900000', '60000'], {
      input,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    return output === ''
      ? null
      : (JSON.parse(output) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput
          .updatedInput;
  };

  const hook = (toolInput: unknown) => runHook(`{"tool_name":"Bash","tool_input":${JSON.stringify(toolInput)}}`);

  /** The watchdog's reason, script, call id, deadline, Claude's pid and background limit, as the hook started it. */
  const watchdog = () => {
    const lines = readFileSync(join(bin, 'watchdog'), 'utf8').trimEnd().split('\n');
    const [script, id, deadline, claude, backgroundLimit] = lines.slice(-5);

    return {
      reason: lines[0],
      script,
      id,
      deadlineMs: Number(deadline),
      claudePid: Number(claude),
      backgroundLimitMs: Number(backgroundLimit),
    };
  };

  it('marks the command on its first line, announces its shell to the watchdog, and keeps its other input', () => {
    const input = hook({ command: `echo "it's"\nls`, description: 'List', dangerouslyDisableSandbox: false });

    expect(input?.command).toBe(`${marker(watchdog().id, 4242)}echo "it's"\nls`);
    expect(watchdog().id).toMatch(/^[0-9a-f]{16}$/);
    expect(input).toMatchObject({ description: 'List', dangerouslyDisableSandbox: false });
  });

  it.each([
    [{}, 180_000],
    [{ timeout: 15_000 }, 75_000],
    [{ timeout: 900_000 }, 660_000],
    [{ timeout: 1500.5 }, 61_500],
    [{ timeout: 0 }, 180_000],
    [{ timeout: '5000' }, 180_000],
    [{ timeout: null }, 180_000],
    [JSON.parse('{"run_in_background":true}'), 960_000],
    [JSON.parse('{"run_in_background":true,"timeout":5000}'), 65_000],
    [JSON.parse('{"run_in_background":true,"timeout":7200000}'), 660_000],
  ])('starts the watchdog on the marked call at its deadline, for %j', (extraInput, deadlineMs) => {
    hook({ command: 'make', ...extraInput });

    const started = watchdog();

    expect(started.script).toBe(COMMAND_WATCHDOG_SOURCE);
    expect(started.deadlineMs).toBe(deadlineMs);
    expect(started.backgroundLimitMs).toBe('run_in_background' in extraInput ? deadlineMs - 60_000 : 0);
    expect(started.claudePid).toBe(parentOfSession('self'));
    expect(started.reason).toBe(
      `Swarmfoundry stopped this command, and every process it started, after ${Math.floor(deadlineMs / 1000)}s: ` +
        `its limit of ${Math.floor(deadlineMs / 1000) - 60}s plus 60s grace.`
    );
    expect(started.reason).toMatch(COMMAND_STOPPED_LINE);
  });

  const captured = fixture('hook-input.jsonl').trim().split('\n');

  it.each([
    [0, 180_000, { timeout: 190_000 }],
    [1, 180_000, { timeout: 190_000 }],
    [2, 960_000, { timeout: 900_000 }],
  ])('marks call %i of those captured from Claude Code', (index, deadlineMs, extraInput) => {
    const line = captured[index] ?? '';
    const toolInput = (JSON.parse(line) as Record<string, { command: string }>).tool_input;
    const input = runHook(line);

    expect(input).toEqual({
      ...toolInput,
      command: `${marker(watchdog().id, 4242)}${toolInput.command}`,
      ...extraInput,
    });
    expect(watchdog().deadlineMs).toBe(deadlineMs);
  });

  it.each([
    [{}, 190_000],
    [{ timeout: 15_000 }, 85_000],
    [{ timeout: 900_000 }, 670_000],
  ])("raises a foreground call's timeout past its kill, from %j", (input, timeoutMs) => {
    expect(hook({ command: 'make', ...input })?.timeout).toBe(timeoutMs);
  });

  it.each([
    [{}, 900_000],
    [{ timeout: 5000 }, 5000],
    [{ timeout: 7_200_000 }, 600_000],
  ])('gives a background call its limit as its timeout, from %j', (input, timeoutMs) => {
    expect(hook({ command: 'make', ...JSON.parse('{"run_in_background":true}'), ...input })?.timeout).toBe(timeoutMs);
  });

  it.each([
    ['npm test\necho done', undefined, 'npm test'],
    ['npm test', '', 'npm test'],
    ['x'.repeat(100), undefined, 'x'.repeat(80)],
  ])("describes %j by its command's first line, never the marker", (command, description, expected) => {
    expect(hook({ command, description })?.description).toBe(expected);
  });

  it('answers nothing for a call without a command', () => {
    expect(hook({ timeout: 5000 })).toBeNull();
  });

  it.each([
    ['input that is not JSON', 'not json', true, /parse error/],
    ['no jq', '{"tool_input":{"command":"make"}}', false, /jq: command not found/],
  ])('fails on %s, so the hook command blocks the call', (_case, input, withJq, error) => {
    for (const tool of ['od', 'tr', 'dirname', ...(withJq ? ['jq'] : [])]) {
      symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(bin, tool));
    }

    const run = () =>
      execFileSync('/bin/bash', [COMMAND_LIMIT_SOURCE, '1', '1', '1', '1'], {
        input,
        env: { PATH: bin },
        stdio: 'pipe',
      });

    expect(run).toThrow(error);
  });

  it.each([
    ['answers no pid', 'echo started'],
    ['never answers, within the hook timeout', 'exec sleep 10'],
  ])('fails when the watchdog %s', (_case, setsid) => {
    writeFileSync(join(bin, 'setsid'), `#!/bin/sh\n${setsid}\n`);

    const started = Date.now();

    expect(() => hook({ command: 'make' })).toThrow();
    expect(Date.now() - started).toBeLessThan(7000);
  });

  it('returns at once, and its watchdog stops the marked command at the deadline', async () => {
    const started = Date.now();
    const output = execFileSync(
      '/usr/bin/env',
      [
        '-i',
        `PATH=${process.env.PATH ?? ''}`,
        'bash',
        '--norc',
        '--noprofile',
        COMMAND_LIMIT_SOURCE,
        '1000',
        '1000',
        '1000',
        '1000',
      ],
      { input: `{"tool_input":{"command":"echo ready; bash -c 'trap \\"\\" TERM; sleep 300'"}}`, encoding: 'utf8' }
    );

    expect(Date.now() - started).toBeLessThan(1000);

    const command = (JSON.parse(output) as { hookSpecificOutput: { updatedInput: { command: string } } })
      .hookSpecificOutput.updatedInput.command;
    const shell = startShell(command, join(bin, 'output'), join(bin, 'cwd'));

    expect(await new Promise(resolve => shell.on('exit', (_code, signal) => resolve(signal)))).toBe('SIGKILL');
    expect(readFileSync(join(bin, 'output'), 'utf8')).toBe(`ready\n\n${REASON}\n`);
  });
});

describe.runIf(process.platform === 'linux')('command-watchdog.sh', () => {
  let dir: string;
  let id: string;
  let spawned: ChildProcess[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'command-watchdog-'));
    // Unique, so the watchdog cannot match another process on the host.
    id = randomBytes(8).toString('hex');
    spawned = [];
  });

  /** Every process carrying this test's marker, in its environment or, as a subshell, in its arguments. */
  const markedPids = () =>
    readdirSync('/proc')
      .filter(entry => /^\d+$/.test(entry))
      .filter(entry => {
        try {
          return (
            readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`SWARMFOUNDRY_CALL=${id}`) ||
            readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(`SWARMFOUNDRY_CALL=${id}; `)
          );
        } catch {
          // Gone, or another user's.
          return false;
        }
      })
      .map(Number);

  afterEach(() => {
    for (const pid of [...spawned.map(child => child.pid ?? 0), ...markedPids()]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }

    rmSync(dir, { recursive: true, force: true });
  });

  /** Starts a watchdog as the hook does, with this process as Claude, once it has printed its pid. */
  const watch = async (deadlineMs: number, claudePid = process.pid, backgroundLimitMs = 0) => {
    const started = Date.now();
    const watchdog = spawn(
      'bash',
      [
        '--norc',
        '--noprofile',
        COMMAND_WATCHDOG_SOURCE,
        id,
        String(deadlineMs),
        String(claudePid),
        String(backgroundLimitMs),
      ],
      { env: { PATH: process.env.PATH, SWARMFOUNDRY_REASON: REASON }, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    spawned.push(watchdog);

    const exited = new Promise<number>(resolve => watchdog.on('exit', () => resolve(Date.now() - started)));
    const pid = await new Promise<number>(resolve =>
      watchdog.stdout.once('data', (chunk: Buffer) => resolve(Number.parseInt(chunk.toString(), 10)))
    );

    return { pid, exited };
  };

  /** Runs `command` marked by the hook for `watchdogPid`, as Claude would, and resolves once it prints `ready`. */
  const runCommand = async (
    command: string,
    watchdogPid: number,
    { callId = id, output = 'output', heredoc = false, env = process.env } = {}
  ) => {
    const marked = `${marker(callId, watchdogPid)}${command}`;
    const shell = startShell(marked, join(dir, output), join(dir, 'cwd'), heredoc, env);

    spawned.push(shell);

    const exited = new Promise<NodeJS.Signals | null>(resolve => shell.on('exit', (_code, signal) => resolve(signal)));

    await vi.waitFor(() => expect(readFileSync(join(dir, output), 'utf8')).toContain('ready'), { timeout: 5000 });

    return { shell, exited };
  };

  const HANG = `bash -c 'trap "" TERM; sleep 300'`;

  it.each([
    ['ignores SIGTERM', `echo ready; ${HANG}`, false],
    ['waits on stdin in the shell itself', 'echo ready; read line', true],
    ['loops in the shell itself', 'echo ready; while :; do :; done', false],
    ['loops in a subshell', 'echo ready; ( while :; do :; done )', false],
    ['waits on a child holding its output', `echo ready; bash -c '(trap "" TERM; exec sleep 300) & wait'`, false],
    ['leaves its process group', `echo ready; setsid -w ${HANG}`, false],
    ['replaces its shell', `echo ready; exec bash -c 'trap "" TERM; sleep 300; true'`, false],
    ['replaces its shell after a cd', `echo ready; cd /tmp && exec bash -c 'trap "" TERM; sleep 300; true'`, false],
  ])('kills a command that %s at the deadline, writing the reason first', async (_case, command, heredoc) => {
    const watchdog = await watch(1000);
    const { exited } = await runCommand(command, watchdog.pid, { heredoc });

    expect(await exited).toBe('SIGKILL');
    expect(await watchdog.exited).toBeGreaterThanOrEqual(1000);
    expect(readFileSync(join(dir, 'output'), 'utf8')).toBe(`ready\n\n${REASON}\n`);
    await vi.waitFor(() => expect(markedPids()).toEqual([]));
  });

  it('writes the reason where a command that redirects its own errors sends them', async () => {
    const log = join(dir, 'log');
    const watchdog = await watch(1000);
    const { exited } = await runCommand(`echo ready; { ${HANG}; } > ${log} 2>&1`, watchdog.pid);

    expect(await exited).toBe('SIGKILL');
    expect(readFileSync(log, 'utf8')).toBe(`\n${REASON}\n`);
  });

  it.each([
    ['its errors to a pipe', `exec 2> >(cat > /dev/null); echo ready; ${HANG}`],
    ['only its output elsewhere', `echo ready; exec > LOG; ${HANG}`],
  ])("writes the reason to the call's output when the shell sends %s", async (_case, command) => {
    const watchdog = await watch(1000);
    const { exited } = await runCommand(command.replace('LOG', join(dir, 'log')), watchdog.pid);

    expect(await exited).toBe('SIGKILL');
    expect(readFileSync(join(dir, 'output'), 'utf8')).toBe(`ready\n\n${REASON}\n`);
  });

  it('marks and announces the command past functions named echo and export in the shell', async () => {
    const pidFile = join(dir, 'child');
    const watchdog = await watch(1000);
    const { exited } = await runCommand(
      `printf 'ready\\n'; bash -c 'echo $$ > ${pidFile}; trap "" TERM; sleep 300'`,
      watchdog.pid,
      {
        env: {
          ...process.env,
          'BASH_FUNC_echo%%': '() { builtin printf "FN:%s\\n" "$*"; }',
          'BASH_FUNC_export%%': '() { :; }',
        },
      }
    );

    expect(await exited).toBe('SIGKILL');
    await vi.waitFor(() => expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false));
  });

  it('runs none of the lines after the hung one', async () => {
    const watchdog = await watch(1000);
    const { exited } = await runCommand(`echo ready; ${HANG}\necho next-line`, watchdog.pid);

    await exited;

    expect(readFileSync(join(dir, 'output'), 'utf8')).not.toContain('next-line');
  });

  it('counts the deadline from when the shell starts, as other hooks can hold it back', async () => {
    const watchdog = await watch(1000);

    await new Promise(resolve => setTimeout(resolve, 1500));

    const { exited } = await runCommand(`echo ready; ${HANG}`, watchdog.pid);

    expect(await exited).toBe('SIGKILL');
    expect(await watchdog.exited).toBeGreaterThanOrEqual(2500);
  });

  it.each([
    ['&', 'sleep 300 > /dev/null 2>&1 &'],
    ['nohup', 'nohup sleep 300 > /dev/null 2>&1 &'],
    ['setsid', 'setsid sleep 300 > /dev/null 2>&1 < /dev/null &'],
    ['a cd first', 'mkdir -p sub && cd sub && sleep 300 > /dev/null 2>&1 &'],
    ['a subshell', '(sleep 300 > /dev/null 2>&1 &)'],
    ['disown', 'sleep 300 > /dev/null 2>&1 & disown'],
  ])('leaves a process put in the background with %s running once the call is over', async (_case, command) => {
    const watchdog = await watch(60_000);
    const { exited } = await runCommand(`cd ${dir}; ${command}\necho ready`, watchdog.pid);

    await exited;

    expect(await watchdog.exited).toBeLessThan(5000);
    expect(markedPids()).not.toEqual([]);
  });

  it('kills what a hung call put in the background', async () => {
    const watchdog = await watch(1000);
    const { exited } = await runCommand(
      `setsid sleep 300 > /dev/null 2>&1 < /dev/null & nohup sleep 300 > /dev/null 2>&1 & echo ready; ${HANG}`,
      watchdog.pid
    );

    expect(await exited).toBe('SIGKILL');
    await vi.waitFor(() => expect(markedPids()).toEqual([]));
  });

  it('kills what a background call put in the background once Claude stops the call at its limit', async () => {
    const watchdog = await watch(3000, process.pid, 1000);
    const { shell } = await runCommand(
      `setsid sleep 300 > /dev/null 2>&1 < /dev/null & echo ready; sleep 300`,
      watchdog.pid
    );

    // As Claude stops a background call, by signalling the shell's process group.
    await new Promise(resolve => setTimeout(resolve, 1000));
    process.kill(-(shell.pid ?? 0), 'SIGKILL');

    expect(await watchdog.exited).toBeLessThan(3000);
    await vi.waitFor(() => expect(markedPids()).toEqual([]));
  });

  it('leaves what a background call put in the background once the call ends before its limit', async () => {
    const watchdog = await watch(60_000, process.pid, 30_000);
    const { exited } = await runCommand(`setsid sleep 300 > /dev/null 2>&1 < /dev/null & echo ready`, watchdog.pid);

    await exited;

    expect(await watchdog.exited).toBeLessThan(5000);
    expect(markedPids()).not.toEqual([]);
  });

  it('leaves no marked process from a command that keeps forking', async () => {
    const watchdog = await watch(1000);

    await runCommand(
      `echo ready; bash -c 'while :; do (trap "" TERM; exec sleep 300) & sleep 0.005; done'`,
      watchdog.pid
    );
    await watchdog.exited;

    await vi.waitFor(() => expect(markedPids()).toEqual([]));
  });

  it("leaves another call's command running", async () => {
    const other = await runCommand('echo ready; sleep 300', 0, { callId: 'other', output: 'other' });
    const watchdog = await watch(1000);
    const { exited } = await runCommand(`echo ready; ${HANG}`, watchdog.pid);

    await exited;

    expect(isAlive(other.shell.pid ?? 0)).toBe(true);
  });

  it('exits once the call is over, without waiting for the deadline', async () => {
    const watchdog = await watch(60_000);
    const { exited } = await runCommand('echo ready', watchdog.pid);

    await exited;

    expect(await watchdog.exited).toBeLessThan(5000);
  });

  it('exits once Claude is gone, without a shell to watch', async () => {
    const claude = spawn('sleep', ['0.5']);
    const watchdog = await watch(60_000, claude.pid);

    expect(await watchdog.exited).toBeLessThan(5000);
  });
});
