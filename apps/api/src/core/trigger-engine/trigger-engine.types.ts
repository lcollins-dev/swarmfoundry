import type { ITriggerConfig } from '@/core/foundry-config/foundry-config.types';
import type { IIssueChange } from '@/core/issue-source/issue-source.types';

export interface ITriggerMatch {
  trigger: ITriggerConfig;

  /**
   * The newest add among `issue.labels`, remove among `issue.notLabels` or assignment of an `issue.anyAssignee` user
   * inside the poll's window, which keys dedup.
   */
  change: IIssueChange;
}

/** `defer` when the issue could not be read. */
export type TaskCheck = { kind: 'start' } | { kind: 'cancel'; reason: string } | { kind: 'defer'; error: string };
