import type { QueueWaitDto, StepList, TriggerDto, TriggerStatsDto, TriggerStepDto } from '@libs/dto';

import { formatShortDayTime } from '@/utils/format/date';

export const TRIGGER_KIND_LABELS: Record<TriggerDto['kind'], string> = {
  issue: 'Issue',
  schedule: 'Schedule',
  mergeRequest: 'Merge request',
};

export const triggerPath = (name: string): string => `/triggers/${encodeURIComponent(name)}`;

/** What starts the trigger, as short as a table cell needs. The trigger page lists every rule. */
export const triggerSummary = (trigger: TriggerDto): string => {
  if (trigger.issue !== null) {
    return `Issue · ${trigger.issue.labels.length > 0 ? trigger.issue.labels.join(', ') : 'any'}`;
  }

  if (trigger.mergeRequest !== null) {
    return `MR · ${trigger.mergeRequest.event} to ${trigger.mergeRequest.targetBranch ?? 'any branch'}`;
  }

  if (trigger.schedule !== null) {
    return `Cron · ${trigger.schedule.cron}`;
  }

  return TRIGGER_KIND_LABELS[trigger.kind];
};

export interface ITriggerRule {
  label: string;
  /** Where it sits in the trigger's config. */
  key: string;
  /** Each shown as code. */
  values: string[];
  note?: string;
}

const ALL_PROJECTS_NOTE = 'All projects in this source.';

/** Only the rules the trigger sets, besides its source, projects and concurrency. */
export const triggerRules = (trigger: TriggerDto): ITriggerRule[] => {
  const rules: ITriggerRule[] = [{ label: 'Source', key: 'source', values: [trigger.sourceName] }];
  const addIfSet = (rule: ITriggerRule) => {
    if (rule.values.length > 0) {
      rules.push(rule);
    }
  };

  if (trigger.issue !== null) {
    const { labels, notLabels, anyAssignee, projects, expect } = trigger.issue;

    addIfSet({ label: 'Has all labels', key: 'issue.labels', values: labels });
    addIfSet({ label: 'Has none of', key: 'issue.notLabels', values: notLabels });
    addIfSet({ label: 'Assigned to any of', key: 'issue.anyAssignee', values: anyAssignee });
    rules.push({
      label: 'Projects',
      key: 'issue.projects',
      values: projects,
      note: projects.length === 0 ? ALL_PROJECTS_NOTE : undefined,
    });
    addIfSet({
      label: 'Expected afterwards',
      key: 'issue.expect.anyLabel',
      values: expect.anyLabel,
      note: 'The issue must have at least one of these labels when the steps finish.',
    });
  }

  if (trigger.mergeRequest !== null) {
    const { event, targetBranch, labels, notLabels, projects } = trigger.mergeRequest;

    rules.push({ label: 'Event', key: 'mergeRequest.event', values: [event] });
    rules.push({
      label: 'Target branch',
      key: 'mergeRequest.targetBranch',
      values: targetBranch === null ? [] : [targetBranch],
      note: targetBranch === null ? 'Any branch.' : undefined,
    });
    addIfSet({ label: 'Has all labels', key: 'mergeRequest.labels', values: labels });
    addIfSet({ label: 'Has none of', key: 'mergeRequest.notLabels', values: notLabels });
    rules.push({
      label: 'Projects',
      key: 'mergeRequest.projects',
      values: projects,
      note: projects.length === 0 ? ALL_PROJECTS_NOTE : undefined,
    });
  }

  if (trigger.schedule !== null) {
    rules.push({ label: 'Schedule', key: 'schedule.cron', values: [trigger.schedule.cron], note: 'Uses UTC.' });
    rules.push({ label: 'Project', key: 'schedule.project', values: [trigger.schedule.project] });
  }

  rules.push({
    label: 'Concurrency',
    key: 'concurrency',
    values: [String(trigger.concurrency)],
  });

  return rules;
};

export const STEP_KIND_LABELS: Record<TriggerStepDto['kind'], string> = {
  agent: 'Agent',
  relabel: 'Relabel',
  comment: 'Comment',
  assign: 'Assign',
};

/** From 0 to 1 as a whole percentage, or `-` with no finished task. */
export const formatSuccessRate = (successRate: number | null): string =>
  successRate === null ? '-' : `${Math.round(successRate * 100)}%`;

/** Every trigger's 7-day stats added up, the durations left out since percentiles do not add. */
export const sumStats = (triggers: TriggerDto[]): Omit<TriggerStatsDto, 'medianDurationMs' | 'p90DurationMs'> => {
  const finishedCount = triggers.reduce((sum, trigger) => sum + trigger.stats.finishedCount, 0);
  const succeededCount = triggers.reduce((sum, trigger) => sum + trigger.stats.succeededCount, 0);

  return {
    finishedCount,
    succeededCount,
    successRate: finishedCount === 0 ? null : succeededCount / finishedCount,
    succeededCostUsd: triggers.reduce((sum, trigger) => sum + trigger.stats.succeededCostUsd, 0),
    failedCostUsd: triggers.reduce((sum, trigger) => sum + trigger.stats.failedCostUsd, 0),
  };
};

/** Why a queued task waits, in plain words. */
export const queueWaitLabel = (wait: QueueWaitDto): string => {
  switch (wait.reason) {
    case 'noFreeSlot':
      return `No free slot · ${wait.name} ${wait.inUse}/${wait.limit}`;

    case 'heldBack':
      return `Held back · ${formatShortDayTime(wait.until)}`;

    case 'ready':
      return 'Ready';

    case 'notInConfig':
      return 'Not in config';
  }
};

/** The timeout of the step a task is at in the running config. Null for a static step, or one no longer there. */
export const stepTimeoutMs = (trigger: TriggerDto | undefined, list: StepList, step: number): number | null => {
  const configured = trigger?.[list][step];

  return configured?.kind === 'agent' ? configured.timeoutMs : null;
};
