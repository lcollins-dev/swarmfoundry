import { describe, expect, it } from 'vitest';

import { Task } from '@/core/task/entities/task.entity';

import { QueueSlotsService } from './queue-slots.service';
import { QueueStatusService } from './queue-status.service';
import type { StepExecutorService } from '@/core/actions/step-executor.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskReadService } from '@/core/task/task-read.service';
import type { IListSteps, TaskService } from '@/core/task/task.service';

import type { IActionAgent } from '@/core/actions/types/actions.types';
import type { IStepConfig, ITriggerConfig } from '@/core/foundry-config/types/foundry-config.types';
import { StepList, TaskStatus } from '@/core/task/types/task.types';

const NOW = new Date('2026-10-30T12:00:00Z');

type ITestAgent = Pick<IActionAgent, 'name' | 'concurrency'>;

const CLAUDE: ITestAgent = { name: 'claude', concurrency: 1 };
const UNCAPPED: ITestAgent = { name: 'claude-api' };

const agentStep = (agent: ITestAgent) => ({ kind: 'agent', agent }) as unknown as IStepConfig;
const relabelStep = {
  kind: 'relabel',
  add: ['foundry::running'],
  remove: [],
  written: { add: ['foundry::running'], remove: [] },
} as IStepConfig;

const trigger = (name: string, concurrency: number, steps: IStepConfig[]) =>
  ({ name, concurrency, steps, failureSteps: [] }) as unknown as ITriggerConfig;

let nextId = 1;

const task = (triggerName: string, status: TaskStatus, fields: Partial<Task> = {}): Task => {
  const created = new Task({
    triggerName,
    sourceName: 'gitlab',
    projectId: 7,
    projectPath: 'group/project',
    projectUrl: 'https://gitlab.test/group/project',
    issueIid: nextId,
    issueTitle: `Issue ${nextId}`,
    issueUrl: `https://gitlab.test/group/project/-/issues/${nextId}`,
    matchedIssue: null,
    change: null,
    fireTime: null,
    cron: null,
    mergeRequest: null,
    queuedDate: new Date(NOW.getTime() - 60_000 + nextId),
  });

  created.id = nextId++;
  created.status = status;

  return Object.assign(created, fields);
};

const serviceOver = (triggers: ITriggerConfig[], tasks: Task[]) => {
  const isAt = (candidate: Task, at?: IListSteps) =>
    at === undefined || (candidate.list === at.list && at.steps.includes(candidate.step));

  const taskService = {
    countRunning: (triggerName: string, at?: IListSteps) =>
      Promise.resolve(
        tasks.filter(
          candidate =>
            candidate.triggerName === triggerName && candidate.status === TaskStatus.RUNNING && isAt(candidate, at)
        ).length
      ),
  } as unknown as TaskService;

  const stepExecutor = {
    agentOf: (step: IStepConfig) => (step.kind === 'agent' ? step.agent : null),
  } as unknown as StepExecutorService;

  const taskReadService = {
    findQueued: () =>
      Promise.resolve(
        tasks
          .filter(candidate => candidate.status === TaskStatus.QUEUED)
          .map(queued => ({
            task: queued,
            totals: { runCount: 0, startDate: null, totalTokens: null, costUsd: null, furthestStep: null },
          }))
      ),
  } as unknown as TaskReadService;

  return new QueueStatusService(
    { triggers } as unknown as FoundryConfigService,
    taskReadService,
    new QueueSlotsService(taskService, stepExecutor)
  );
};

const waitsOf = async (service: QueueStatusService) =>
  (await service.findQueued(NOW)).map(({ summary, wait }) => ({ id: summary.task.id, wait }));

describe('QueueStatusService', () => {
  it('names the trigger whose slots are full, counting the ready tasks ahead in the queue', async () => {
    const running = task('implement', TaskStatus.RUNNING);
    const ready = task('implement', TaskStatus.QUEUED);
    const waiting = task('implement', TaskStatus.QUEUED);

    const service = serviceOver([trigger('implement', 2, [agentStep(UNCAPPED)])], [running, ready, waiting]);

    expect(await waitsOf(service)).toEqual([
      { id: ready.id, wait: { reason: 'ready' } },
      { id: waiting.id, wait: { reason: 'noFreeSlot', on: 'trigger', name: 'implement', inUse: 2, limit: 2 } },
    ]);
  });

  it("names the agent whose slots another trigger's running step holds", async () => {
    const running = task('triage', TaskStatus.RUNNING);
    const waiting = task('implement', TaskStatus.QUEUED);

    const service = serviceOver(
      [trigger('triage', 1, [agentStep(CLAUDE)]), trigger('implement', 1, [agentStep(CLAUDE)])],
      [running, waiting]
    );

    expect(await waitsOf(service)).toEqual([
      { id: waiting.id, wait: { reason: 'noFreeSlot', on: 'agent', name: 'claude', inUse: 1, limit: 1 } },
    ]);
  });

  it('counts the slots in use past a cap that a reload lowered', async () => {
    const running = [1, 2, 3].map(() => task('implement', TaskStatus.RUNNING));
    const triageRunning = [1, 2].map(() => task('triage', TaskStatus.RUNNING));
    const waiting = task('implement', TaskStatus.QUEUED);
    const blocked = task('triage', TaskStatus.QUEUED);

    const service = serviceOver(
      [trigger('implement', 1, [agentStep(UNCAPPED)]), trigger('triage', 3, [agentStep(CLAUDE)])],
      [...running, ...triageRunning, waiting, blocked]
    );

    expect(await waitsOf(service)).toEqual([
      { id: waiting.id, wait: { reason: 'noFreeSlot', on: 'trigger', name: 'implement', inUse: 3, limit: 1 } },
      { id: blocked.id, wait: { reason: 'noFreeSlot', on: 'agent', name: 'claude', inUse: 2, limit: 1 } },
    ]);
  });

  it('holds no agent slot for a static step', async () => {
    const running = task('implement', TaskStatus.RUNNING);
    const relabel = task('triage', TaskStatus.QUEUED, { step: 1 });

    const service = serviceOver(
      [trigger('implement', 1, [agentStep(CLAUDE)]), trigger('triage', 1, [agentStep(CLAUDE), relabelStep])],
      [running, relabel]
    );

    expect(await waitsOf(service)).toEqual([{ id: relabel.id, wait: { reason: 'ready' } }]);
  });

  it('holds a task back until its time, taking no slot from those behind it', async () => {
    const until = new Date(NOW.getTime() + 300_000);
    const retry = task('implement', TaskStatus.QUEUED, { notBeforeDate: until });
    const next = task('implement', TaskStatus.QUEUED);
    const past = task('implement', TaskStatus.QUEUED, { notBeforeDate: new Date(NOW.getTime() - 1) });

    const service = serviceOver([trigger('implement', 2, [agentStep(UNCAPPED)])], [retry, next, past]);

    expect(await waitsOf(service)).toEqual([
      { id: retry.id, wait: { reason: 'heldBack', until } },
      { id: next.id, wait: { reason: 'ready' } },
      { id: past.id, wait: { reason: 'ready' } },
    ]);
  });

  it('says when no pass would pick a task, its trigger or step gone from the config', async () => {
    const gone = task('removed', TaskStatus.QUEUED);
    const missingStep = task('implement', TaskStatus.QUEUED, { step: 3 });
    const missingFailureStep = task('implement', TaskStatus.QUEUED, { list: StepList.FAILURE_STEPS });

    const service = serviceOver(
      [trigger('implement', 1, [agentStep(CLAUDE)])],
      [gone, missingStep, missingFailureStep]
    );

    expect((await waitsOf(service)).map(({ wait }) => wait)).toEqual([
      { reason: 'notInConfig' },
      { reason: 'notInConfig' },
      { reason: 'notInConfig' },
    ]);
  });
});
