import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENTRYPOINT_SOURCE } from './agent-runner.service';

/** Records its working directory and arguments, one line per call. */
const stub = (log: string, extra = '') => `#!/bin/sh\necho "$PWD $*" >> ${log}\n${extra}\n`;

describe('agent-entrypoint.sh', () => {
  let dir: string;
  let workdir: string;
  let log: string;
  let script: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-entrypoint-'));
    workdir = join(dir, 'home');
    log = join(dir, 'calls.log');

    const bin = join(dir, 'bin');
    const tools = {
      git: stub(log, 'if [ "$1" = clone ]; then mkdir "$4"; fi'),
      claude: stub(log),
      id: '#!/bin/sh\necho 1000\n',
    };

    mkdirSync(bin);
    mkdirSync(workdir);
    mkdirSync(join(dir, 'foundry'));
    writeFileSync(join(dir, 'foundry', 'prompt.md'), 'Implement #3');

    for (const [name, content] of Object.entries(tools)) {
      writeFileSync(join(bin, name), content);
      chmodSync(join(bin, name), 0o755);
    }

    script = join(dir, 'entrypoint.sh');
    writeFileSync(script, readFileSync(ENTRYPOINT_SOURCE, 'utf8').replaceAll('/foundry/', `${dir}/foundry/`));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clones into a new folder in the image's working directory and runs Claude there", () => {
    execFileSync('bash', [script], {
      cwd: workdir,
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        HOME: dir,
        GITLAB_HOST: 'gitlab.example.com',
        GITLAB_TOKEN: 'token',
        REPO_URL: 'https://gitlab.example.com/group/project.git',
        MODEL: 'opus',
        GIT_AUTHOR_NAME: 'Bot',
        GIT_AUTHOR_EMAIL: 'bot@example.com',
        GIT_COMMITTER_NAME: 'Bot',
        GIT_COMMITTER_EMAIL: 'bot@example.com',
      },
    });

    const calls = readFileSync(log, 'utf8').trim().split('\n');

    expect(calls).toContain(`${workdir} clone --quiet https://gitlab.example.com/group/project.git project`);
    expect(calls.at(-1)).toContain(`${join(workdir, 'project')} -p `);
  });
});
