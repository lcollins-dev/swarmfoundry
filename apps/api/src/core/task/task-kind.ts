import type { Task } from './entities/task.entity';

import type { TriggerKind } from '@/core/foundry-config/foundry-config.types';

/** `CHK_task_kind` holds each row to exactly one kind. */
export function taskKindOf(task: Pick<Task, 'fireTime' | 'mergeRequestIid'>): TriggerKind {
  if (task.fireTime !== null) {
    return 'schedule';
  }

  return task.mergeRequestIid === null ? 'issue' : 'mergeRequest';
}
