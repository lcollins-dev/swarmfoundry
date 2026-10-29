import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@/core/task/entities/task.entity';

import type { TaskQueueService } from './task-queue.service';
import type { TaskRecoveryService } from './task-recovery.service';
import { TriggerEngineService } from './trigger-engine.service';
import { TriggerMatchService } from './trigger-match.service';
import type { TriggerScheduleService } from './trigger-schedule.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { IssueSourceService } from '@/core/issue-source/issue-source.service';
import type { TaskService } from '@/core/task/task.service';

import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import type { IIssueEvent, IMergeRequestEvent, SourceEventHandler } from '@/core/issue-source/issue-source.types';

const LABEL = 'workflow::in-progress';

const triggers = [
  {
    name: 'implement',
    source: { name: 'gitlab' },
    issue: { labels: [LABEL], notLabels: [], anyAssignee: [], projects: [] },
  },
  {
    name: 'notify',
    source: { name: 'gitlab' },
    issue: { labels: [LABEL], notLabels: [], anyAssignee: [], projects: [] },
  },
  {
    name: 'merged',
    source: { name: 'gitlab' },
    mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [] },
  },
] as unknown as ITriggerConfig[];

const event: IIssueEvent = {
  source: 'gitlab',
  project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
  issue: {
    iid: 1,
    title: 'Issue 1',
    url: 'https://gitlab.test/i/1',
    labels: [LABEL],
    author: 'ada',
    assignees: [],
    updatedAt: new Date(),
  },
  labelEvents: [{ id: 10, label: LABEL, action: 'add', createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' }],
  assignments: [],
};

const labelChange = { kind: 'label', id: 10, createdAt: new Date('2026-10-14T10:00:00Z'), actor: 'ada' };

const mergeRequestEvent: IMergeRequestEvent = {
  source: 'gitlab',
  project: event.project,
  event: 'merged',
  mergeRequest: {
    iid: 2,
    title: 'Fix it (#1)',
    url: 'https://gitlab.test/mr/2',
    sourceBranch: '1-fix-it',
    targetBranch: 'master',
    labels: [],
  },
  relatedIssue: { iid: 1, title: 'Issue 1', url: 'https://gitlab.test/i/1' },
};

describe('TriggerEngineService', () => {
  let calls: string[];
  let handler: SourceEventHandler | null;
  let enqueue: ReturnType<typeof vi.fn>;
  let enqueueMergeRequest: ReturnType<typeof vi.fn>;
  let requestDispatch: ReturnType<typeof vi.fn>;
  let requestTick: ReturnType<typeof vi.fn>;
  let swapListeners: Set<() => void>;
  let service: TriggerEngineService;

  beforeEach(() => {
    calls = [];
    handler = null;
    swapListeners = new Set();

    enqueue = vi.fn((triggerName: string) => Promise.resolve({ id: 1, triggerName } as Task));
    enqueueMergeRequest = vi.fn((triggerName: string) => Promise.resolve({ id: 2, triggerName } as Task));
    requestDispatch = vi.fn(() => {
      calls.push('dispatch');

      return Promise.resolve();
    });
    requestTick = vi.fn(() => {
      calls.push('tick');

      return Promise.resolve();
    });

    const issueSourceService = {
      start: (eventHandler: SourceEventHandler) => {
        calls.push('start');
        handler = eventHandler;

        return () => {
          calls.push('stopSource');

          return Promise.resolve();
        };
      },
    } as unknown as IssueSourceService;

    const taskQueueService = {
      requestDispatch,
      stop: () => {
        calls.push('stopQueue');

        return Promise.resolve();
      },
    } as unknown as TaskQueueService;

    service = new TriggerEngineService(
      {
        triggers,
        onSwap: (listener: () => void) => {
          swapListeners.add(listener);

          return () => swapListeners.delete(listener);
        },
      } as unknown as FoundryConfigService,
      issueSourceService,
      new TriggerMatchService(),
      { enqueue, enqueueMergeRequest } as unknown as TaskService,
      taskQueueService,
      {
        recover: () => {
          calls.push('recover');

          return Promise.resolve();
        },
      } as unknown as TaskRecoveryService,
      {
        requestTick,
        stop: () => {
          calls.push('stopSchedule');

          return Promise.resolve();
        },
      } as unknown as TriggerScheduleService
    );

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers running tasks, then resumes the queue, before the source and the schedule start', async () => {
    await service.onApplicationBootstrap();

    expect(calls).toEqual(['recover', 'dispatch', 'start', 'tick']);
  });

  it('stops the schedule and the source before the queue', async () => {
    await service.onApplicationBootstrap();
    await service.beforeApplicationShutdown();

    expect(calls.slice(-3)).toEqual(['stopSchedule', 'stopSource', 'stopQueue']);
  });

  it('requests a dispatch and a schedule tick after each config swap until shutdown', async () => {
    await service.onApplicationBootstrap();
    requestDispatch.mockClear();
    requestTick.mockClear();

    for (const listener of swapListeners) {
      listener();
    }

    expect(requestDispatch).toHaveBeenCalledOnce();
    expect(requestTick).toHaveBeenCalledOnce();

    await service.beforeApplicationShutdown();

    expect(swapListeners.size).toBe(0);
  });

  it('enqueues one task per matching trigger, keyed on the latest change', async () => {
    await service.onApplicationBootstrap();
    await handler?.(event);

    expect(enqueue.mock.calls).toEqual([
      ['implement', event, labelChange],
      ['notify', event, labelChange],
    ]);
    expect(requestDispatch).toHaveBeenCalledTimes(2);
  });

  it('requests a dispatch even when every match already had a task', async () => {
    enqueue.mockResolvedValue(null);

    await service.onApplicationBootstrap();
    await handler?.(event);

    expect(requestDispatch).toHaveBeenCalledTimes(2);
  });

  it('requests no dispatch for an event that matches no trigger', async () => {
    await service.handleEvent({ ...event, issue: { ...event.issue, labels: [] } });

    expect(requestDispatch).not.toHaveBeenCalled();
  });

  it('enqueues nothing for an issue that matches no trigger', async () => {
    await service.handleEvent({ ...event, issue: { ...event.issue, labels: [] } });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one task per merge request trigger the event matches, and requests a dispatch', async () => {
    await service.onApplicationBootstrap();
    requestDispatch.mockClear();

    await handler?.(mergeRequestEvent);

    expect(enqueueMergeRequest.mock.calls).toEqual([['merged', mergeRequestEvent]]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(requestDispatch).toHaveBeenCalledOnce();
  });

  it('requests a dispatch when the merge request task already existed', async () => {
    enqueueMergeRequest.mockResolvedValue(null);

    await service.handleEvent(mergeRequestEvent);

    expect(requestDispatch).toHaveBeenCalledOnce();
  });

  it('enqueues nothing and requests no dispatch for a merge request event no trigger wants', async () => {
    await service.handleEvent({ ...mergeRequestEvent, event: 'opened' });

    expect(enqueueMergeRequest).not.toHaveBeenCalled();
    expect(requestDispatch).not.toHaveBeenCalled();
  });
});
