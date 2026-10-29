import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDatabaseConfig, recreateDatabase } from '../../utils/database';
import { migrations } from '@/database/migrations';
import { AddRunUsage1792968532047 } from '@/database/migrations/1792968532047-AddRunUsage';

const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"num_turns":12,"total_cost_usd":1.234567,' +
  '"usage":{"input_tokens":40,"output_tokens":3000,"cache_read_input_tokens":900000,' +
  '"cache_creation_input_tokens":"many"}}';

/** The past runs, by id: a container, a result, an outcome, a deployment fault and an error. Each has ended but 10. */
const RUNS: [number, string | null, string | null, string | null, string | null, string | null][] = [
  [1, 'agent-1', RESULT_LINE, 'succeeded', null, null],
  [2, null, 'Added workflow::review', 'succeeded', null, null],
  [3, 'agent-3', '{"type":"result"', 'failed', null, 'Timed out after 2 hours, stopped with SIGINT'],
  [4, null, null, 'failed', 'transient', 'pull access denied'],
  [5, 'agent-5', null, 'failed', null, "Claude's plugins failed: enabled plugin dev@acme did not load"],
  [6, 'agent-6', null, 'failed', null, 'The agent exited with code 1'],
  [7, 'agent-7', RESULT_LINE, 'failed', null, 'The run ended without the issue carrying workflow::review'],
  [8, null, null, 'failed', null, 'GitLab user lookup failed'],
  [9, null, null, 'failed', null, 'steps[1] (relabel) failed: GitLab answered 403 to PUT /projects/7/issues/3'],
  [10, 'agent-10', null, null, null, null],
  [11, 'agent-11', null, 'failed', null, "Failed to read the issue's labels to judge the run: GitLab answered 503"],
  [12, 'agent-12', null, null, null, 'Timed out after 2 hours, stopped with SIGINT'],
  [13, 'agent-13', null, 'failed', null, 'Claude exited without reporting system/init, so its plugins went unchecked'],
  [14, 'agent-14', null, 'failed', null, 'Failed to store the transcript: connection lost'],
  [15, 'agent-15', null, 'failed', null, 'The issue no longer exists, so the run could not be judged'],
  [16, 'agent-16', null, 'failed', null, 'Trigger implement is no longer in the config'],
  [17, 'agent-17', null, 'failed', null, 'The config revision the task is pinned to, config_revision 3, does not load'],
];

describe('The deploy that records run usage (integration)', () => {
  const config = { ...getDatabaseConfig(), database: 'swarmfoundry_run_usage_int' };
  const index = migrations.indexOf(AddRunUsage1792968532047);
  let dataSource: DataSource;

  const connect = (upTo: number) =>
    new DataSource({
      type: 'postgres',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      migrations: migrations.slice(0, upTo),
    }).initialize();

  beforeAll(async () => {
    await recreateDatabase(config);

    const before = await connect(index);
    await before.runMigrations();

    await before.query(
      `INSERT INTO task (id, "triggerName", "sourceName", "projectId", "projectPath", "projectUrl", "issueIid",
         "issueTitle", "issueUrl", "changeKind", "changeId", "changeDate", status, "queuedDate")
       VALUES (1, 'implement', 'gitlab', 7, 'group/project', 'https://gitlab.test/group/project', 1, 'Issue 1',
         'https://gitlab.test/i/1', 'label', 100, now(), 'failed', now())`
    );

    for (const [id, containerId, result, outcome, deploymentFault, error] of RUNS) {
      await before.query(
        `INSERT INTO run (id, "taskId", number, list, step, "startDate", "endDate", "containerId", result, outcome,
           "deploymentFault", error)
         VALUES ($1, 1, $1, 'steps', 0, now(), $2, $3, $4, $5, $6, $7)`,
        [id, id === 10 ? null : new Date(), containerId, result, outcome, deploymentFault, error]
      );
    }

    await before.destroy();

    dataSource = await connect(index + 1);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("copies a past agent run's usage from its result line, leaving a malformed field empty", async () => {
    expect(
      await dataSource.query(
        `SELECT id, turns, "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"
           FROM run WHERE id IN (1, 7) ORDER BY id`
      )
    ).toEqual(
      [1, 7].map(id => ({
        id,
        turns: 12,
        inputTokens: '40',
        outputTokens: '3000',
        cacheReadTokens: '900000',
        cacheWriteTokens: null,
        costUsd: '1.234567',
      }))
    );
  });

  it("leaves usage empty on a static step's run and on a result line that does not parse", async () => {
    expect(
      await dataSource.query(
        `SELECT id FROM run WHERE num_nonnulls(turns, "inputTokens", "outputTokens", "cacheReadTokens",
           "cacheWriteTokens", "costUsd") > 0 ORDER BY id`
      )
    ).toEqual([{ id: 1 }, { id: 7 }]);
  });

  it("derives each past end reason from the outcome, deployment fault and error, and a stored report's runner view", async () => {
    const rows: { id: number; endReason: string | null }[] = await dataSource.query(
      'SELECT id, "endReason" FROM run ORDER BY id'
    );

    expect(rows.map(row => row.endReason)).toEqual([
      'success',
      'success',
      'timeout',
      'runnerError',
      'runnerError',
      'error',
      'error',
      'runnerError',
      'error',
      null,
      'runnerError',
      'timeout',
      'runnerError',
      'runnerError',
      'runnerError',
      'runnerError',
      'runnerError',
    ]);
  });

  it('leaves the match-time issue state and the agent empty, since nothing held them', async () => {
    expect(await dataSource.query('SELECT "issueLabels", "issueAuthor", "issueAssignees" FROM task')).toEqual([
      { issueLabels: null, issueAuthor: null, issueAssignees: null },
    ]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM run WHERE num_nonnulls("agentName", "agentModel", "agentAuth") > 0'
      )
    ).toEqual([{ count: 0 }]);
  });

  it('refuses match-time issue state on a scheduled task', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO task ("triggerName", "sourceName", "projectPath", "projectUrl", "fireTime", cron, "issueLabels",
           status, "queuedDate")
         VALUES ('friction', 'gitlab', 'group/project', 'https://gitlab.test/group/project', now(), '0 9 * * 1',
           '{workflow::ready}', 'queued', now())`
      )
    ).rejects.toThrow(/CHK_task_kind/);
  });
});
