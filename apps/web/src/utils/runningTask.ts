import type { TriggerDto } from '@libs/dto';

import type { IRunningTask } from '@/composables/useRunningTasks';

import { type ITaskSubject, spanMs, stepLabel, taskSubject } from '@/utils/task';
import { STEP_KIND_LABELS, stepTimeoutMs } from '@/utils/trigger';

import type { MeterTone } from '@/components/ui';

export interface IRunningTaskRow extends IRunningTask {
  subject: ITaskSubject;
  /** The subject's `#iid` or `!iid` without its project, or `Scheduled`. */
  shortReference: string;
  onRunningConfig: boolean;
  step: string;
  /** Null between runs. */
  elapsedMs: number | null;
  /** Null for a task pinned to an older config, as `triggers` holds only the running one. */
  timeoutMs: number | null;
}

/** Counts elapsed time to the moment of the call. */
export const runningTaskRow = (
  { task, run }: IRunningTask,
  triggers: TriggerDto[],
  configSha: string | null
): IRunningTaskRow => {
  const trigger = triggers.find(listed => listed.name === task.triggerName);
  const onRunningConfig = task.configSha === configSha;
  const kind = onRunningConfig ? trigger?.[task.list][task.step]?.kind : undefined;
  const subject = taskSubject(task);

  return {
    task,
    run,
    subject,
    shortReference: subject.url === null ? subject.reference : subject.reference.slice(task.projectPath.length),
    onRunningConfig,
    step:
      kind === undefined
        ? stepLabel(task.list, task.step)
        : `${stepLabel(task.list, task.step)} · ${STEP_KIND_LABELS[kind]}`,
    elapsedMs: run === null ? null : spanMs(run.startDate, null),
    timeoutMs: onRunningConfig ? stepTimeoutMs(trigger, task.list, task.step) : null,
  };
};

export const elapsedMeterTone = (fraction: number): MeterTone => {
  if (fraction >= 1) {
    return 'error';
  }

  return fraction >= 0.8 ? 'warning' : 'primary';
};
