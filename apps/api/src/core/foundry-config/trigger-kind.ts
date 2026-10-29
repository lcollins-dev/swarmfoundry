import type { TriggerKind } from './foundry-config.types';

interface ITriggerBlocks {
  issue?: unknown;
  schedule?: unknown;
  mergeRequest?: unknown;
}

/** The schema holds a trigger to exactly one block. */
export function triggerKindOf(trigger: ITriggerBlocks): TriggerKind {
  if (trigger.schedule !== undefined) {
    return 'schedule';
  }

  return trigger.mergeRequest === undefined ? 'issue' : 'mergeRequest';
}
