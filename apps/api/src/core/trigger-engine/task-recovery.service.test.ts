import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Run } from '@/core/task/entities/run.entity';
import { Task } from '@/core/task/entities/task.entity';

import type { TaskQueueService } from './task-queue.service';
import { TaskRecoveryService } from './task-recovery.service';
import { ActionRegistryService } from '@/core/actions/action-registry.service';
import { AgentActionService } from '@/core/actions/agent-action.service';
import type { IssueActionService } from '@/core/actions/issue-action.service';
import { StepExecutorService } from '@/core/actions/step-executor.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskService } from '@/core/task/task.service';

import type { IAgentRunner } from '@/core/actions/actions.types';
import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { StepList, TaskStatus, type IRunningTask } from '@/core/task/task.types';

const CONFIG_A = 11;
const CONFIG_B = 12;

const runningTask = (
  id: number,
  triggerName = 'implement',
  endDate: Date | null = null,
  configId: number | null = null
): IRunningTask => {
  const task = new Task({
    triggerName,
    sourceName: 'gitlab',
    projectId: 7,
    projectPath: 'group/project',
    projectUrl: 'https://gitlab.test/group/project',
    issueIid: id,
    issueTitle: `Issue ${id}`,
    issueUrl: `https://gitlab.test/group/project/-/issues/${id}`,
    matchedIssue: null,
    change: { kind: 'label', id: id * 10, createdAt: new Date('2026-10-14T10:00:00Z'), actor: null },
    fireTime: null,
    cron: null,
    mergeRequest: null,
    queuedDate: new Date(),
  });
  task.id = id;
  task.status = TaskStatus.RUNNING;
  task.configId = configId;

  const run = new Run({
    taskId: id,
    number: 1,
    list: StepList.STEPS,
    step: 0,
    startDate: new Date(),
    configId,
    agent: null,
  });
  run.id = 100 + id;
  run.endDate = endDate;

  return { task, run };
};

describe('TaskRecoveryService', () => {
  let running: IRunningTask[];
  let calls: string[];
  let taskService: {
    findRunning: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    findPinnedConfigIds: ReturnType<typeof vi.fn>;
  };
  let loadable: Set<number>;
  let resumeRun: ReturnType<typeof vi.fn>;
  let removeSandboxesExcept: ReturnType<typeof vi.fn>;
  let foundryConfigService: FoundryConfigService;

  const create = (runner?: IAgentRunner) =>
    new TaskRecoveryService(
      foundryConfigService,
      taskService as unknown as TaskService,
      { resumeRun } as unknown as TaskQueueService,
      new StepExecutorService(
        new ActionRegistryService(
          new AgentActionService(foundryConfigService, taskService as unknown as TaskService, runner),
          { isReady: () => true, removeLeftoversExcept: () => Promise.resolve() } as unknown as IssueActionService
        )
      )
    );

  beforeEach(() => {
    running = [];
    calls = [];

    taskService = {
      findRunning: vi.fn(() => Promise.resolve(running)),
      release: vi.fn(() => Promise.resolve()),
      findPinnedConfigIds: vi.fn(() =>
        Promise.resolve(new Set(running.flatMap(({ task }) => (task.configId === null ? [] : [task.configId]))))
      ),
    };
    loadable = new Set([CONFIG_A]);
    resumeRun = vi.fn((task: Task) => calls.push(`resume ${task.id}`));
    removeSandboxesExcept = vi.fn((runIds: ReadonlySet<number>) => {
      calls.push(`sweep ${[...runIds].join(',')}`);

      return Promise.resolve();
    });
    const triggers = [
      { name: 'implement', steps: [{ kind: 'agent' }], failureSteps: [{ kind: 'comment' }] },
    ] as unknown as ITriggerConfig[];
    const loaded = new Set<number>();

    foundryConfigService = {
      triggers,
      triggerAt: (configId: number | null, name: string) =>
        configId === null || loaded.has(configId) ? triggers.find(trigger => trigger.name === name) : undefined,
      loadRevision: vi.fn((configId: number) => {
        calls.push(`load ${configId}`);

        if (loadable.has(configId)) {
          loaded.add(configId);
        }

        return Promise.resolve(loadable.has(configId));
      }),
    } as unknown as FoundryConfigService;

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  it('sweeps every sandbox but those of runs still to follow, then hands each task to the queue', async () => {
    running = [runningTask(1), runningTask(2, 'implement', new Date()), runningTask(3, 'removed')];

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(calls).toEqual(['sweep 101', 'resume 1', 'resume 2', 'resume 3']);
  });

  it('follows no run whose step its trigger no longer has', async () => {
    const gone = runningTask(4);
    running = [runningTask(1), { ...gone, run: Object.assign(gone.run ?? {}, { step: 1 }) as Run }];

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(calls).toEqual(['sweep 101', 'resume 1', 'resume 4']);
  });

  it('follows a run of failureSteps by its own list', async () => {
    const failing = runningTask(5);
    const gone = runningTask(6);
    running = [
      { ...failing, run: Object.assign(failing.run ?? {}, { list: StepList.FAILURE_STEPS }) as Run },
      { ...gone, run: Object.assign(gone.run ?? {}, { list: StepList.FAILURE_STEPS, step: 1 }) as Run },
    ];

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(calls).toEqual(['sweep 105', 'resume 5', 'resume 6']);
  });

  it('loads the revisions running tasks are pinned to first, and follows no run whose revision does not load', async () => {
    running = [runningTask(1, 'implement', null, CONFIG_A), runningTask(2, 'implement', null, CONFIG_B)];

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(calls).toEqual([`load ${CONFIG_A}`, `load ${CONFIG_B}`, 'sweep 101', 'resume 1', 'resume 2']);
  });

  it('sweeps orphaned sandboxes when no task was left running', async () => {
    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(calls).toEqual(['sweep ']);
  });

  it('queues a running task that has no run', async () => {
    running = [{ ...runningTask(1), run: null }];

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(taskService.release).toHaveBeenCalledWith(running[0].task);
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it('touches nothing without a runner', async () => {
    running = [runningTask(1)];

    await create().recover();

    expect(taskService.findRunning).not.toHaveBeenCalled();
  });

  it('touches nothing without a trigger, such as when the config is missing', async () => {
    foundryConfigService = { triggers: [] } as unknown as FoundryConfigService;

    await create({ removeSandboxesExcept } as unknown as IAgentRunner).recover();

    expect(taskService.findRunning).not.toHaveBeenCalled();
    expect(removeSandboxesExcept).not.toHaveBeenCalled();
  });

  it('never rejects', async () => {
    taskService.findRunning.mockRejectedValue(new Error('connection lost'));

    await expect(create({ removeSandboxesExcept } as unknown as IAgentRunner).recover()).resolves.toBeUndefined();
  });
});
