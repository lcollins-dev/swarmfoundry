import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { Task } from '@/core/task/entities/task.entity';

import type { TaskQueueService } from './task-queue.service';
import { SCHEDULE_TICK_MS, TriggerScheduleService } from './trigger-schedule.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskService } from '@/core/task/task.service';

import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import { type IScheduledTaskFields, TaskStatus } from '@/core/task/task.types';

const scheduled = (name: string, cron: string) =>
  ({
    name,
    source: { name: 'gitlab', url: 'https://gitlab.test/' },
    schedule: { cron, project: 'group/project' },
  }) as unknown as ITriggerConfig;

const labelled = {
  name: 'implement',
  source: { name: 'gitlab', url: 'https://gitlab.test' },
  issue: { labels: ['workflow::ready'], notLabels: [], anyAssignee: [], projects: [] },
} as unknown as ITriggerConfig;

const HOURLY = scheduled('hourly', '0 * * * *');

const latestTask = (fireTime: string, status: TaskStatus, cron = '0 * * * *') =>
  ({ id: 1, fireTime: new Date(fireTime), cron, status }) as Task;

describe('TriggerScheduleService', () => {
  let triggers: ITriggerConfig[];
  let latest: Map<string, Task>;
  let enqueueScheduled: Mock<(fields: IScheduledTaskFields) => Promise<Task | null>>;
  let findLatestScheduled: Mock<(triggerName: string) => Promise<Task | null>>;
  let requestDispatch: Mock<() => Promise<void>>;
  let service: TriggerScheduleService;

  const queuedFireTimes = () => enqueueScheduled.mock.calls.map(([fields]) => fields.fireTime.toISOString());

  /** Lets the service's own timers drive its ticks, so a test proves it wakes when it should. */
  const advance = async (milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await new Promise(resolve => setImmediate(resolve));
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-19T09:20:00Z'));

    triggers = [HOURLY];
    latest = new Map();

    findLatestScheduled = vi.fn((triggerName: string) => Promise.resolve(latest.get(triggerName) ?? null));
    enqueueScheduled = vi.fn((fields: IScheduledTaskFields) => {
      const task = { id: 2, ...fields, status: TaskStatus.QUEUED } as unknown as Task;
      latest.set(fields.triggerName, task);

      return Promise.resolve(task);
    });
    requestDispatch = vi.fn(() => Promise.resolve());

    service = new TriggerScheduleService(
      {
        get triggers() {
          return triggers;
        },
      } as unknown as FoundryConfigService,
      { findLatestScheduled, enqueueScheduled } as unknown as TaskService,
      { requestDispatch } as unknown as TaskQueueService
    );

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queues nothing for a fire time from before it first saw a trigger, then queues the next one on time', async () => {
    await service.requestTick();

    expect(enqueueScheduled).not.toHaveBeenCalled();

    await advance(40 * 60_000);

    expect(queuedFireTimes()).toEqual(['2026-10-19T10:00:00.000Z']);
    expect(requestDispatch).toHaveBeenCalledOnce();
  });

  it('wakes at the fire time rather than the next periodic tick', async () => {
    vi.setSystemTime(new Date('2026-10-19T09:59:50Z'));

    await service.requestTick();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(queuedFireTimes()).toEqual(['2026-10-19T10:00:00.000Z']);
  });

  it('queues only the latest fire time missed during downtime', async () => {
    latest.set('hourly', latestTask('2026-10-19T05:00:00Z', TaskStatus.SUCCEEDED));

    await service.requestTick();

    expect(queuedFireTimes()).toEqual(['2026-10-19T09:00:00.000Z']);
  });

  it('queues the task with its one project, its source and the project URL', async () => {
    latest.set('hourly', latestTask('2026-10-19T08:00:00Z', TaskStatus.FAILED));

    await service.requestTick();

    expect(enqueueScheduled).toHaveBeenCalledExactlyOnceWith({
      triggerName: 'hourly',
      sourceName: 'gitlab',
      projectPath: 'group/project',
      projectUrl: 'https://gitlab.test/group/project',
      fireTime: new Date('2026-10-19T09:00:00Z'),
      cron: '0 * * * *',
    });
  });

  it('queues nothing again for a fire time that has its task', async () => {
    latest.set('hourly', latestTask('2026-10-19T09:00:00Z', TaskStatus.SUCCEEDED));

    await service.requestTick();
    await advance(SCHEDULE_TICK_MS);

    expect(enqueueScheduled).not.toHaveBeenCalled();
  });

  it.each([TaskStatus.QUEUED, TaskStatus.RUNNING])(
    "queues nothing while the trigger's last task is %s, then the latest fire time missed once it ends",
    async status => {
      latest.set('hourly', latestTask('2026-10-19T08:00:00Z', status));

      await service.requestTick();
      await advance(60 * 60_000);

      expect(enqueueScheduled).not.toHaveBeenCalled();

      latest.set('hourly', latestTask('2026-10-19T08:00:00Z', TaskStatus.SUCCEEDED));
      await advance(SCHEDULE_TICK_MS);

      expect(queuedFireTimes()).toEqual(['2026-10-19T10:00:00.000Z']);
    }
  );

  it('requests no dispatch when the fire time already had a task', async () => {
    latest.set('hourly', latestTask('2026-10-19T08:00:00Z', TaskStatus.SUCCEEDED));
    enqueueScheduled.mockResolvedValue(null);

    await service.requestTick();

    expect(enqueueScheduled).toHaveBeenCalledOnce();
    expect(requestDispatch).not.toHaveBeenCalled();
  });

  it('leaves label triggers alone', async () => {
    triggers = [labelled];

    await service.requestTick();
    await advance(2 * 60 * 60_000);

    expect(findLatestScheduled).not.toHaveBeenCalled();
  });

  it('queues the other triggers when one fails, and tries the failed one again on the next tick', async () => {
    const daily = scheduled('daily', '0 0 * * *');
    triggers = [HOURLY, daily];
    latest.set('hourly', latestTask('2026-10-19T08:00:00Z', TaskStatus.SUCCEEDED));
    latest.set('daily', latestTask('2026-10-18T00:00:00Z', TaskStatus.SUCCEEDED, '0 0 * * *'));
    findLatestScheduled.mockRejectedValueOnce(new Error('connection lost'));

    await service.requestTick();

    expect(queuedFireTimes()).toEqual(['2026-10-19T00:00:00.000Z']);

    await advance(SCHEDULE_TICK_MS);

    expect(queuedFireTimes()).toEqual(['2026-10-19T00:00:00.000Z', '2026-10-19T09:00:00.000Z']);
  });

  it('treats a trigger removed and added again as new', async () => {
    await service.requestTick();

    triggers = [];
    await service.requestTick();
    await advance(60 * 60_000);

    triggers = [HOURLY];
    await service.requestTick();

    expect(enqueueScheduled).not.toHaveBeenCalled();
  });

  it('queues the latest fire time at once for a trigger added back after its last task ended', async () => {
    latest.set('hourly', latestTask('2026-10-19T06:00:00Z', TaskStatus.SUCCEEDED));
    triggers = [];
    await service.requestTick();

    triggers = [HOURLY];
    await service.requestTick();

    expect(queuedFireTimes()).toEqual(['2026-10-19T09:00:00.000Z']);
  });

  it('waits for the first fire time after a cron change rather than one the new cron passed earlier', async () => {
    vi.setSystemTime(new Date('2026-10-21T15:00:00Z'));
    triggers = [scheduled('hourly', '0 9 * * 1')];
    latest.set('hourly', latestTask('2026-10-19T09:00:00Z', TaskStatus.SUCCEEDED, '0 9 * * 1'));
    await service.requestTick();

    triggers = [scheduled('hourly', '0 12 * * *')];
    await service.requestTick();

    expect(enqueueScheduled).not.toHaveBeenCalled();

    await advance(21 * 60 * 60_000);

    expect(queuedFireTimes()).toEqual(['2026-10-22T12:00:00.000Z']);
  });

  it('waits after a cron change even when the old fire time is also one of the new cron', async () => {
    vi.setSystemTime(new Date('2026-10-21T15:00:00Z'));
    triggers = [scheduled('hourly', '0 9 * * *')];
    latest.set('hourly', latestTask('2026-10-19T09:00:00Z', TaskStatus.SUCCEEDED, '0 9 * * 1'));

    await service.requestTick();

    expect(enqueueScheduled).not.toHaveBeenCalled();

    await advance(18 * 60 * 60_000);

    expect(queuedFireTimes()).toEqual(['2026-10-22T09:00:00.000Z']);
  });

  it('queues the latest fire time at once when a cron changes back to the one its latest task was queued by', async () => {
    vi.setSystemTime(new Date('2026-10-21T15:00:00Z'));
    triggers = [scheduled('hourly', '0 12 * * *')];
    latest.set('hourly', latestTask('2026-10-20T12:00:00Z', TaskStatus.SUCCEEDED, '0 12 * * *'));
    await service.requestTick();

    triggers = [scheduled('hourly', '0 9 * * 1')];
    await service.requestTick();

    triggers = [scheduled('hourly', '0 12 * * *')];
    await service.requestTick();

    expect(queuedFireTimes()).toEqual(['2026-10-21T12:00:00.000Z']);
  });

  it("queues nothing when the latest task fired after the cron's latest fire time, as after a cron change", async () => {
    triggers = [scheduled('yearly', '0 0 1 1 *')];
    latest.set('yearly', latestTask('2026-10-19T08:00:00Z', TaskStatus.SUCCEEDED, '0 0 1 1 *'));

    await service.requestTick();

    expect(enqueueScheduled).not.toHaveBeenCalled();
  });

  it('runs a request made during a tick once more after it, and no more', async () => {
    await Promise.all([service.requestTick(), service.requestTick(), service.requestTick()]);

    expect(findLatestScheduled).toHaveBeenCalledTimes(2);
  });

  it('never rejects, and tries again after a failure outside any one trigger', async () => {
    let reads = 0;

    service = new TriggerScheduleService(
      {
        get triggers() {
          reads++;

          if (reads === 1) {
            throw new Error('The Swarmfoundry config was read before it loaded');
          }

          return triggers;
        },
      } as unknown as FoundryConfigService,
      { findLatestScheduled, enqueueScheduled } as unknown as TaskService,
      { requestDispatch } as unknown as TaskQueueService
    );

    await expect(service.requestTick()).resolves.toBeUndefined();

    await advance(SCHEDULE_TICK_MS);

    expect(findLatestScheduled).toHaveBeenCalledOnce();
  });

  it('ticks no more once stopped', async () => {
    await service.requestTick();
    await service.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(findLatestScheduled).toHaveBeenCalledOnce();
  });
});
