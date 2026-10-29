import { describe, expect, it } from 'vitest';

import { issuesFromZod } from '@/core/foundry-config/foundry-config.error';
import { foundryConfigDocumentSchema } from '@/core/foundry-config/schema/document';
import { DEFAULT_POLL_INTERVAL_MS } from '@/core/foundry-config/schema/sources';
import { DEFAULT_CONCURRENCY } from '@/core/foundry-config/schema/triggers';

const source = { type: 'gitlab', url: 'https://gitlab.example.com', token: 'token', projects: ['acme/app'] };
const agent = { type: 'claude', auth: 'oauth', token: 'token', model: 'claude-opus-5-5' };
const environment = { image: 'agent:latest', agent: { name: 'claude' } };
const agentStep = { environment: 'node', prompt: './prompt.md', timeout: '60m' };
const trigger = {
  source: 'gitlab',
  steps: [{ agent: agentStep }],
  issue: { labels: ['workflow::in-progress'] },
};

const withAgentStep = (fields: Record<string, unknown>) => ({
  ...trigger,
  steps: [{ agent: { ...agentStep, ...fields } }],
});

const config = (overrides: Record<string, unknown> = {}) => ({
  sources: { gitlab: source },
  agents: { claude: agent },
  environments: { node: environment },
  triggers: { implement: trigger },
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = foundryConfigDocumentSchema.safeParse(input);

  return result.success ? [] : issuesFromZod(result.error.issues);
};

describe('foundryConfigDocumentSchema', () => {
  it('accepts a minimal config and fills in the defaults', () => {
    const parsed = foundryConfigDocumentSchema.parse(config());

    expect(parsed.sources.gitlab.pollInterval).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(parsed.triggers.implement).toMatchObject({
      steps: [{ agent: { timeout: 60 * 60_000 } }],
      concurrency: DEFAULT_CONCURRENCY,
      issue: { notLabels: [], anyAssignee: [], projects: [], expect: { anyLabel: [] } },
    });
    expect(parsed.triggers.implement.failureSteps).toBeUndefined();
    expect(parsed.environments.node).toMatchObject({ env: {}, mounts: [], services: {}, resources: {} });
  });

  it('reads the usernames a trigger accepts as assignee', () => {
    const issue = { labels: ['workflow::ready'], anyAssignee: ['swarmfoundry-bot', 'ada.lovelace_2'] };
    const parsed = foundryConfigDocumentSchema.parse(config({ triggers: { implement: { ...trigger, issue } } }));

    expect(parsed.triggers.implement.issue).toMatchObject({ ...issue, notLabels: [], projects: [] });
  });

  it.each(['@swarmfoundry-bot', '', 'two words', '-bot'])('refuses %j as an assignee', assignee => {
    const issue = { labels: ['workflow::ready'], anyAssignee: [assignee] };

    expect(issuesOf(config({ triggers: { implement: { ...trigger, issue } } }))).toEqual([
      {
        path: 'triggers.implement.issue.anyAssignee[0]',
        message: "must be a username without the '@', holding only letters, digits, '.', '_' or '-'",
      },
    ]);
  });

  it('refuses the old all-of assignees and expect.labelsAfter keys, naming each path', () => {
    const issue = { labels: ['workflow::ready'], assignees: ['swarmfoundry-bot'], expect: { labelsAfter: ['done'] } };

    expect(issuesOf(config({ triggers: { implement: { ...trigger, issue } } }))).toEqual([
      { path: 'triggers.implement.issue.expect.labelsAfter', message: 'is not a known key' },
      { path: 'triggers.implement.issue.assignees', message: 'is not a known key' },
    ]);
  });

  it('reads durations into milliseconds', () => {
    const parsed = foundryConfigDocumentSchema.parse(
      config({ triggers: { implement: withAgentStep({ timeout: '1.5m' }) } })
    );

    expect(parsed.triggers.implement.steps[0].agent?.timeout).toBe(90_000);
  });

  it('refuses a duration without a unit, or of zero', () => {
    expect(issuesOf(config({ triggers: { implement: withAgentStep({ timeout: '30' }) } }))).toEqual([
      {
        path: 'triggers.implement.steps[0].agent.timeout',
        message: 'must be a duration with a unit, such as 90s, 30m or 2h',
      },
    ]);

    expect(issuesOf(config({ triggers: { implement: withAgentStep({ timeout: '0s' }) } }))).toEqual([
      { path: 'triggers.implement.steps[0].agent.timeout', message: 'must be longer than 0' },
    ]);
  });

  it('reads memory into bytes', () => {
    const parsed = foundryConfigDocumentSchema.parse(
      config({ environments: { node: { ...environment, resources: { cpus: 4, memory: '8g' } } } })
    );

    expect(parsed.environments.node.resources).toEqual({ cpus: 4, memory: 8 * 1024 ** 3 });
  });

  it('refuses memory it cannot read', () => {
    expect(issuesOf(config({ environments: { node: { ...environment, resources: { memory: 'lots' } } } }))).toEqual([
      { path: 'environments.node.resources.memory', message: 'must be a size such as 512m or 8g' },
    ]);
  });

  it('refuses plugins on a claude agent, naming the key', () => {
    expect(issuesOf(config({ agents: { claude: { ...agent, plugins: ['./plugin'] } } }))).toEqual([
      { path: 'agents.claude.plugins', message: 'is not a known key' },
    ]);
  });

  it('reads an agent concurrency, and refuses one below 1', () => {
    const parsed = foundryConfigDocumentSchema.parse(config({ agents: { claude: { ...agent, concurrency: 3 } } }));

    expect(parsed.agents.claude.concurrency).toBe(3);
    expect(parsed.triggers.implement.steps[0].agent?.agent).toBeUndefined();
    expect(issuesOf(config({ agents: { claude: { ...agent, concurrency: 0 } } }))).toMatchObject([
      { path: 'agents.claude.concurrency' },
    ]);
  });

  it('refuses concurrency in a step or environment agent block, so the agent cap has one source', () => {
    const message = 'is set on the agent definition only, so every step of the agent shares one cap';

    expect(
      issuesOf(
        config({
          environments: { node: { ...environment, agent: { name: 'claude', concurrency: 2 } } },
          triggers: { implement: withAgentStep({ agent: { concurrency: 2 } }) },
        })
      )
    ).toEqual([
      { path: 'environments.node.agent.concurrency', message },
      { path: 'triggers.implement.steps[0].agent.agent.concurrency', message },
    ]);
  });

  it('refuses an unknown section and an unknown trigger key', () => {
    expect(issuesOf(config({ trigger: {}, triggers: { implement: { ...trigger, label: 'x' } } }))).toEqual([
      { path: 'triggers.implement.label', message: 'is not a known key' },
      { path: 'trigger', message: 'is not a known key' },
    ]);
  });

  describe('steps', () => {
    it('reads several agent steps in order, under one concurrency for the trigger', () => {
      const steps = [{ agent: agentStep }, { agent: { ...agentStep, prompt: './review.md' } }];
      const parsed = foundryConfigDocumentSchema.parse(
        config({ triggers: { implement: { ...trigger, steps, concurrency: 2 } } })
      );

      expect(parsed.triggers.implement).toMatchObject({
        steps: [{ agent: { prompt: './prompt.md' } }, { agent: { prompt: './review.md' } }],
        concurrency: 2,
      });
    });

    it('refuses concurrency in a step, since it caps the trigger', () => {
      expect(issuesOf(config({ triggers: { implement: withAgentStep({ concurrency: 2 }) } }))).toEqual([
        { path: 'triggers.implement.steps[0].agent.concurrency', message: 'is not a known key' },
      ]);
    });

    it('refuses a trigger concurrency below 1', () => {
      expect(issuesOf(config({ triggers: { implement: { ...trigger, concurrency: 0 } } }))).toMatchObject([
        { path: 'triggers.implement.concurrency' },
      ]);
    });

    it.each([
      ['environment', 'node'],
      ['agent', { name: 'claude' }],
      ['systemPrompt', './system.md'],
      ['prompt', './prompt.md'],
      ['timeout', '60m'],
      ['retries', { max: 1, backoff: '5m' }],
    ])('refuses %s at the top of a trigger, naming its path', (key, value) => {
      expect(issuesOf(config({ triggers: { implement: { ...trigger, [key]: value } } }))).toEqual([
        { path: `triggers.implement.${key}`, message: 'is not a known key' },
      ]);
    });

    it('refuses a trigger with no steps', () => {
      expect(issuesOf(config({ triggers: { implement: { ...trigger, steps: [] } } }))).toEqual([
        { path: 'triggers.implement.steps', message: 'must list at least one step' },
      ]);

      const withoutSteps = { source: trigger.source, issue: trigger.issue };

      expect(issuesOf(config({ triggers: { implement: withoutSteps } }))).toMatchObject([
        { path: 'triggers.implement.steps' },
      ]);
    });

    it('refuses a step with no action, or an action it does not know', () => {
      const steps = [{}, { label: { add: ['x'] } }];
      const message = 'must set exactly one action: agent, relabel, comment, assign';

      expect(issuesOf(config({ triggers: { implement: { ...trigger, steps } } }))).toEqual([
        { path: 'triggers.implement.steps[0]', message },
        { path: 'triggers.implement.steps[1].label', message: 'is not a known key' },
        { path: 'triggers.implement.steps[1]', message },
      ]);
    });

    it('refuses a step that sets two actions', () => {
      const steps = [{ agent: agentStep, comment: 'Done' }];

      expect(issuesOf(config({ triggers: { implement: { ...trigger, steps } } }))).toEqual([
        {
          path: 'triggers.implement.steps[0]',
          message: 'must set exactly one action: agent, relabel, comment, assign',
        },
      ]);
    });

    it('reads the static steps, filling an unset label list with an empty one', () => {
      const steps = [
        { relabel: { add: ['workflow::test'], remove: ['workflow::review'] } },
        { relabel: { remove: ['workflow::review'] } },
        { comment: 'Merged in !{{mergeRequest.iid}}.' },
        { assign: ['ada', 'swarmfoundry-bot'] },
      ];
      const parsed = foundryConfigDocumentSchema.parse(config({ triggers: { implement: { ...trigger, steps } } }));

      expect(parsed.triggers.implement.steps).toEqual([
        { relabel: { add: ['workflow::test'], remove: ['workflow::review'] } },
        { relabel: { add: [], remove: ['workflow::review'] } },
        { comment: 'Merged in !{{mergeRequest.iid}}.' },
        { assign: ['ada', 'swarmfoundry-bot'] },
      ]);
    });

    it('refuses a relabel with no label, an empty comment and an assign with no username', () => {
      const steps = [
        { relabel: {} },
        { comment: ' \n ' },
        { assign: [] },
        { assign: ['@ada'] },
        { relabel: { add: ['a,b'] } },
      ];

      expect(issuesOf(config({ triggers: { implement: { ...trigger, steps } } }))).toEqual([
        { path: 'triggers.implement.steps[0].relabel', message: 'must add or remove at least one label' },
        { path: 'triggers.implement.steps[1].comment', message: 'must not be blank' },
        { path: 'triggers.implement.steps[2].assign', message: 'must list at least one username' },
        {
          path: 'triggers.implement.steps[3].assign[0]',
          message: "must be a username without the '@', holding only letters, digits, '.', '_' or '-'",
        },
        { path: 'triggers.implement.steps[4].relabel.add[0]', message: 'must not hold a comma' },
      ]);
    });
  });

  describe('failureSteps', () => {
    it('reads failureSteps of any kind, and an empty list', () => {
      const failureSteps = [{ relabel: { add: ['foundry::failed'] } }, { agent: agentStep }];
      const parsed = foundryConfigDocumentSchema.parse(
        config({ triggers: { implement: { ...trigger, failureSteps }, quiet: { ...trigger, failureSteps: [] } } })
      );

      expect(parsed.triggers.implement.failureSteps).toMatchObject([
        { relabel: { add: ['foundry::failed'], remove: [] } },
        { agent: { timeout: 60 * 60_000 } },
      ]);
      expect(parsed.triggers.quiet.failureSteps).toEqual([]);
    });

    it('refuses the old onFailure block, naming its path', () => {
      const issue = { labels: ['workflow::ready'], onFailure: { addLabel: 'foundry::failed', comment: true } };

      expect(issuesOf(config({ triggers: { implement: { ...trigger, issue } } }))).toEqual([
        { path: 'triggers.implement.issue.onFailure', message: 'is not a known key' },
      ]);
    });

    it('refuses a failure step with no action, naming its path', () => {
      expect(issuesOf(config({ triggers: { implement: { ...trigger, failureSteps: [{}] } } }))).toEqual([
        {
          path: 'triggers.implement.failureSteps[0]',
          message: 'must set exactly one action: agent, relabel, comment, assign',
        },
      ]);
    });
  });

  it('refuses an agent given as a plain string', () => {
    expect(issuesOf(config({ triggers: { implement: withAgentStep({ agent: 'claude' }) } }))).toMatchObject([
      { path: 'triggers.implement.steps[0].agent.agent' },
    ]);
  });

  it('refuses an environment agent block without a name', () => {
    expect(issuesOf(config({ environments: { node: { ...environment, agent: { model: 'x' } } } }))).toMatchObject([
      { path: 'environments.node.agent.name' },
    ]);
  });

  it('refuses a name it could not use for a container', () => {
    expect(issuesOf(config({ triggers: { 'bad name': trigger } }))).toEqual([
      {
        path: 'triggers.bad name',
        message: "must start with a letter or digit and hold only letters, digits, '.', '_' or '-'",
      },
    ]);
  });

  it("refuses the agent's auth variables in an environment", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' };

    expect(issuesOf(config({ environments: { node: { ...environment, env } } }))).toEqual([
      {
        path: 'environments.node.env.CLAUDE_CODE_OAUTH_TOKEN',
        message: "would override the agent's auth, which the runner sets from its token",
      },
      {
        path: 'environments.node.env.ANTHROPIC_API_KEY',
        message: "would override the agent's auth, which the runner sets from its token",
      },
    ]);
  });

  it.each(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])(
    "refuses %s in an environment, since it would override the agent's auth",
    variable => {
      const env = { [variable]: '1' };

      expect(issuesOf(config({ environments: { node: { ...environment, env } } }))).toEqual([
        {
          path: `environments.node.env.${variable}`,
          message: "would override the agent's auth, which the runner sets from its token",
        },
      ]);
    }
  );

  it('reads a process limit, and refuses one below 1', () => {
    const parsed = foundryConfigDocumentSchema.parse(
      config({ environments: { node: { ...environment, resources: { pids: 512 } } } })
    );

    expect(parsed.environments.node.resources.pids).toBe(512);
    expect(issuesOf(config({ environments: { node: { ...environment, resources: { pids: 0 } } } }))).toMatchObject([
      { path: 'environments.node.resources.pids' },
    ]);
  });

  it('reads env numbers and booleans as strings', () => {
    const parsed = foundryConfigDocumentSchema.parse(
      config({ environments: { node: { ...environment, env: { PORT: 5432, DEBUG: true } } } })
    );

    expect(parsed.environments.node.env).toEqual({ PORT: '5432', DEBUG: 'true' });
  });

  it('refuses a relative mount path', () => {
    const mounts = [{ source: './cache', target: '/home/agent/.npm' }];

    expect(issuesOf(config({ environments: { node: { ...environment, mounts } } }))).toEqual([
      { path: 'environments.node.mounts[0].source', message: 'must be an absolute path' },
    ]);
  });

  it.each([
    '/var/run/docker.sock',
    '/var/run/',
    '/run',
    '/run/user/1000',
    '/run/user/1000/podman/podman.sock',
    '/run/podman',
    '/run/containerd/containerd.sock',
    '/var/lib/containerd',
    '/var/lib/docker/volumes',
    '/proc',
    '/sys/fs',
    '/dev',
    '/var',
    '/',
    '/srv/docker.sock',
  ])('refuses a mount that exposes a runtime socket or host system directory: %s', source => {
    const mounts = [{ source, target: '/mnt' }];

    expect(issuesOf(config({ environments: { node: { ...environment, mounts } } }))).toEqual([
      {
        path: 'environments.node.mounts[0].source',
        message: 'must not expose a container runtime socket or host system directory',
      },
    ]);
  });

  it('defaults a mount to read-only', () => {
    const mounts = [{ source: '/srv/ref', target: '/ref' }];
    const parsed = foundryConfigDocumentSchema.parse(config({ environments: { node: { ...environment, mounts } } }));

    expect(parsed.environments.node.mounts).toEqual([{ source: '/srv/ref', target: '/ref', readOnly: true }]);
  });

  it('keeps an explicit readOnly: false', () => {
    const mounts = [{ source: '/srv/cache', target: '/cache', readOnly: false }];
    const parsed = foundryConfigDocumentSchema.parse(config({ environments: { node: { ...environment, mounts } } }));

    expect(parsed.environments.node.mounts[0]?.readOnly).toBe(false);
  });

  it('accepts a cache mount', () => {
    const mounts = [{ source: '/srv/swarmfoundry/cache/npm', target: '/home/agent/.npm' }];

    expect(issuesOf(config({ environments: { node: { ...environment, mounts } } }))).toEqual([]);
  });

  it('refuses a source url that is not http or https', () => {
    expect(issuesOf(config({ sources: { gitlab: { ...source, url: 'file:///etc/passwd' } } }))).toMatchObject([
      { path: 'sources.gitlab.url' },
    ]);
  });

  it('refuses a source url that holds a username or password', () => {
    for (const url of ['https://ada:hunter2@gitlab.example.com', 'https://ada@gitlab.example.com']) {
      expect(issuesOf(config({ sources: { gitlab: { ...source, url } } }))).toMatchObject([
        { path: 'sources.gitlab.url', message: 'must not hold a username or password; set the token instead' },
      ]);
    }
  });

  describe('trigger kinds', () => {
    const { issue, ...fields } = trigger;
    const scheduled = { ...fields, schedule: { cron: '0 9 * * 1', project: 'acme/app' } };
    const withTrigger = (friction: Record<string, unknown>) => config({ triggers: { friction } });
    const withSchedule = (schedule: Record<string, unknown>) => withTrigger({ ...fields, schedule });

    it('reads a schedule trigger, with no issue block', () => {
      const parsed = foundryConfigDocumentSchema.parse(withTrigger(scheduled));

      expect(parsed.triggers.friction.schedule).toEqual({ cron: '0 9 * * 1', project: 'acme/app' });
      expect(parsed.triggers.friction.issue).toBeUndefined();
    });

    it('refuses a trigger with both an issue and a schedule block', () => {
      expect(issuesOf(withTrigger({ ...scheduled, issue }))).toEqual([
        {
          path: 'triggers.friction',
          message: 'must set exactly one of issue, schedule or mergeRequest, to say what starts it',
        },
      ]);
    });

    it('refuses a trigger with neither block', () => {
      expect(issuesOf(withTrigger(fields))).toEqual([
        {
          path: 'triggers.friction',
          message: 'must set exactly one of issue, schedule or mergeRequest, to say what starts it',
        },
      ]);
    });

    it('refuses the old when block, and an issue key at the top or in the schedule, naming each path', () => {
      expect(
        issuesOf(
          withTrigger({
            ...scheduled,
            when: { labels: ['workflow::ready'] },
            expect: { anyLabel: ['workflow::review'] },
            schedule: {
              ...scheduled.schedule,
              notLabels: ['foundry::failed'],
              expect: { anyLabel: ['workflow::review'] },
              onFailure: { comment: true },
            },
          })
        )
      ).toEqual([
        { path: 'triggers.friction.schedule.notLabels', message: 'is not a known key' },
        { path: 'triggers.friction.schedule.expect', message: 'is not a known key' },
        { path: 'triggers.friction.schedule.onFailure', message: 'is not a known key' },
        { path: 'triggers.friction.when', message: 'is not a known key' },
        { path: 'triggers.friction.expect', message: 'is not a known key' },
      ]);
    });

    it('names the missing block beside the old when block in one load', () => {
      expect(issuesOf(withTrigger({ ...fields, when: { labels: ['workflow::ready'] } }))).toEqual([
        { path: 'triggers.friction.when', message: 'is not a known key' },
        {
          path: 'triggers.friction',
          message: 'must set exactly one of issue, schedule or mergeRequest, to say what starts it',
        },
      ]);
    });

    it('refuses a schedule key in the issue block', () => {
      expect(issuesOf(withTrigger({ ...trigger, issue: { ...issue, cron: '0 9 * * 1' } }))).toEqual([
        { path: 'triggers.friction.issue.cron', message: 'is not a known key' },
      ]);
    });

    it.each([
      '61 * * * *',
      '0 0 30 2 *',
      '0 0 9 * * 1',
      '@weekly',
      'every monday',
      'H 9 * * 1',
      '0 9 * * 1,H',
      '0 9 * * 1-H',
      '*/H * * * *',
      '5H 9 * * *',
      '1H(0-5) 9 * * *',
    ])('refuses %j as a cron expression', cron => {
      expect(issuesOf(withSchedule({ cron, project: 'acme/app' }))).toEqual([
        {
          path: 'triggers.friction.schedule.cron',
          message: 'must be a cron expression of five fields, such as 0 9 * * 1',
        },
      ]);
    });

    it('accepts a weekday name, which H must not be confused with', () => {
      expect(issuesOf(withSchedule({ cron: '0 9 * * thu', project: 'acme/app' }))).toEqual([]);
      expect(issuesOf(withSchedule({ cron: '0 9 * * MON-THU', project: 'acme/app' }))).toEqual([]);
    });

    it('refuses a numeric project id on a schedule, which its agent cannot clone', () => {
      expect(issuesOf(withSchedule({ cron: '0 9 * * 1', project: '123' }))).toEqual([
        {
          path: 'triggers.friction.schedule.project',
          message: 'must be a project path, since its agent clones the project by path',
        },
      ]);
    });

    it('refuses a schedule without a project', () => {
      expect(issuesOf(withSchedule({ cron: '0 9 * * 1' }))).toMatchObject([
        { path: 'triggers.friction.schedule.project' },
      ]);
    });

    describe('mergeRequest', () => {
      const withMergeRequest = (mergeRequest: Record<string, unknown>) => withTrigger({ ...fields, mergeRequest });

      it('reads a merge request trigger, filling its filters with empty lists', () => {
        const parsed = foundryConfigDocumentSchema.parse(withMergeRequest({ event: 'merged' }));

        expect(parsed.triggers.friction.mergeRequest).toEqual({
          event: 'merged',
          labels: [],
          notLabels: [],
          projects: [],
        });
        expect(parsed.triggers.friction.issue).toBeUndefined();
      });

      it('reads every filter', () => {
        const mergeRequest = {
          event: 'opened',
          targetBranch: 'master',
          labels: ['review-me'],
          notLabels: ['wip'],
          projects: ['acme/app'],
        };

        expect(
          foundryConfigDocumentSchema.parse(withMergeRequest(mergeRequest)).triggers.friction.mergeRequest
        ).toEqual(mergeRequest);
      });

      it.each([['updated'], ['closed'], [undefined]])('refuses %j as an event', event => {
        expect(issuesOf(withMergeRequest({ event }))).toMatchObject([{ path: 'triggers.friction.mergeRequest.event' }]);
      });

      it.each([
        ['an issue', { issue }],
        ['a schedule', { schedule: { cron: '0 9 * * 1', project: 'acme/app' } }],
      ])('refuses a merge request block beside %s block, naming the trigger', (_kind, block) => {
        expect(issuesOf(withTrigger({ ...fields, mergeRequest: { event: 'merged' }, ...block }))).toEqual([
          {
            path: 'triggers.friction',
            message: 'must set exactly one of issue, schedule or mergeRequest, to say what starts it',
          },
        ]);
      });

      it('refuses the issue block keys it has no use for, naming each path', () => {
        expect(
          issuesOf(
            withMergeRequest({
              event: 'merged',
              anyAssignee: ['swarmfoundry-bot'],
              expect: { anyLabel: ['workflow::test'] },
              onFailure: { comment: true },
            })
          )
        ).toEqual([
          { path: 'triggers.friction.mergeRequest.anyAssignee', message: 'is not a known key' },
          { path: 'triggers.friction.mergeRequest.expect', message: 'is not a known key' },
          { path: 'triggers.friction.mergeRequest.onFailure', message: 'is not a known key' },
        ]);
      });

      it('refuses an empty target branch', () => {
        expect(issuesOf(withMergeRequest({ event: 'merged', targetBranch: '' }))).toEqual([
          { path: 'triggers.friction.mergeRequest.targetBranch', message: 'must not be empty' },
        ]);
      });
    });
  });
});
