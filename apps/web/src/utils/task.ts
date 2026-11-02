import { RunEndReason, RunOutcome, StepList, TaskStatus, type ListTaskDto, type RunDto } from '@libs/dto';

import type { TagType } from '@/components/ui';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.QUEUED]: 'Queued',
  [TaskStatus.RUNNING]: 'Running',
  [TaskStatus.SUCCEEDED]: 'Succeeded',
  [TaskStatus.FAILED]: 'Failed',
  [TaskStatus.CANCELLED]: 'Cancelled',
};

export const TASK_STATUS_TAG_TYPES: Record<TaskStatus, TagType> = {
  [TaskStatus.QUEUED]: 'warning',
  [TaskStatus.RUNNING]: 'primary',
  [TaskStatus.SUCCEEDED]: 'success',
  [TaskStatus.FAILED]: 'error',
  [TaskStatus.CANCELLED]: 'default',
};

/** A run's outcome, or `running` until it is judged. */
export type TRunStatus = RunOutcome | 'running';

export const runStatus = (run: RunDto): TRunStatus => run.outcome ?? 'running';

export const RUN_STATUS_LABELS: Record<TRunStatus, string> = {
  running: 'Running',
  [RunOutcome.SUCCEEDED]: 'Succeeded',
  [RunOutcome.FAILED]: 'Failed',
};

export const RUN_STATUS_TAG_TYPES: Record<TRunStatus, TagType> = {
  running: 'primary',
  [RunOutcome.SUCCEEDED]: 'success',
  [RunOutcome.FAILED]: 'error',
};

export const RUN_END_REASON_LABELS: Record<RunEndReason, string> = {
  [RunEndReason.SUCCESS]: 'Success',
  [RunEndReason.ERROR]: 'Error',
  [RunEndReason.TIMEOUT]: 'Timeout',
  [RunEndReason.RUNNER_ERROR]: 'Runner error',
};

export const stepLabel = (list: StepList, step: number): string =>
  `${list === StepList.FAILURE_STEPS ? 'Failure step' : 'Step'} ${step + 1}`;

export interface ITaskSubject {
  title: string;
  /** Such as `group/project#<iid>`, `group/project!<iid>` or `Scheduled`. */
  reference: string;
  /** The issue or merge request on GitLab. Null for a scheduled task. */
  url: string | null;
}

export const taskSubject = (task: ListTaskDto): ITaskSubject => {
  if (task.kind === 'mergeRequest' && task.mergeRequest !== null) {
    return {
      title: task.mergeRequest.title,
      reference: `${task.projectPath}!${task.mergeRequest.iid}`,
      url: task.mergeRequest.url,
    };
  }

  if (task.issue !== null) {
    return { title: task.issue.title, reference: `${task.projectPath}#${task.issue.iid}`, url: task.issue.url };
  }

  return { title: `Scheduled · ${task.triggerName}`, reference: 'Scheduled', url: null };
};

export const taskCurrentStep = (task: ListTaskDto): string => {
  if (task.status === TaskStatus.SUCCEEDED) {
    return 'Done';
  }

  if (task.status === TaskStatus.CANCELLED) {
    return 'Cancelled';
  }

  if (task.runCount === 0) {
    return 'Not started';
  }

  // A failed task ends on its failure steps, so name the step that failed instead.
  if (task.status === TaskStatus.FAILED && task.furthestStep !== null) {
    return stepLabel(StepList.STEPS, task.furthestStep);
  }

  return stepLabel(task.list, task.step);
};

/** The tasks on screen out of the total, such as `21-27 of 27 tasks`. Every page but the last is full. */
export const formatTaskCount = (page: number, pages: number, shown: number, total: number): string => {
  const noun = total === 1 ? 'task' : 'tasks';

  if (pages <= 1 || shown === 0) {
    return `${total} ${noun}`;
  }

  const first = page < pages ? (page - 1) * shown + 1 : total - shown + 1;

  return `${first}-${first + shown - 1} of ${total} ${noun}`;
};

/** Up to now while it has not ended. Null before it starts. */
export const spanMs = (startDate: Date | null, endDate: Date | null, now: Date = new Date()): number | null =>
  startDate === null ? null : (endDate ?? now).getTime() - startDate.getTime();

/** Every kind summed, cache reads and writes included. Null when the run recorded no usage. */
export const runTotalTokens = (run: RunDto): number | null => {
  const counts = [run.inputTokens, run.outputTokens, run.cacheReadTokens, run.cacheWriteTokens].filter(
    count => count !== null
  );

  return counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0);
};

/** An `oauth` agent's subscription is not billed per token, so its cost is what the API would charge. */
export interface IStepRuns {
  list: StepList;
  step: number;
  /** Its tries, in the order they started. */
  runs: RunDto[];
}

/** In the order each step first ran. */
export const groupRunsByStep = (runs: RunDto[]): IStepRuns[] => {
  const groups: IStepRuns[] = [];

  for (const run of runs) {
    const group = groups.find(listed => listed.list === run.list && listed.step === run.step);

    if (group === undefined) {
      groups.push({ list: run.list, step: run.step, runs: [run] });
    } else {
      group.runs.push(run);
    }
  }

  return groups;
};
