import type { ListTaskDto } from '@libs/dto';

import type { ITaskSummary } from '@/core/task/task-read.service';

import { taskKindOf } from '@/core/task/utils/task-kind.util';

export function toListTaskDto({ task, totals }: ITaskSummary): ListTaskDto {
  return {
    id: task.id,
    kind: taskKindOf(task),
    triggerName: task.triggerName,
    sourceName: task.sourceName,
    projectPath: task.projectPath,
    projectUrl: task.projectUrl,
    issue:
      task.issueIid === null || task.issueTitle === null || task.issueUrl === null
        ? null
        : { iid: task.issueIid, title: task.issueTitle, url: task.issueUrl },
    mergeRequest:
      task.mergeRequestIid === null ||
      task.mergeRequestEvent === null ||
      task.mergeRequestTitle === null ||
      task.mergeRequestUrl === null ||
      task.sourceBranch === null ||
      task.targetBranch === null
        ? null
        : {
            iid: task.mergeRequestIid,
            event: task.mergeRequestEvent,
            title: task.mergeRequestTitle,
            url: task.mergeRequestUrl,
            sourceBranch: task.sourceBranch,
            targetBranch: task.targetBranch,
          },
    fireTime: task.fireTime,
    status: task.status,
    list: task.list,
    step: task.step,
    runCount: totals.runCount,
    furthestStep: totals.furthestStep,
    totalTokens: totals.totalTokens,
    costUsd: totals.costUsd,
    configSha: task.config?.sha ?? null,
    queuedDate: task.queuedDate,
    startDate: totals.startDate,
    endDate: task.endDate,
    notBeforeDate: task.notBeforeDate,
    cancelReason: task.cancelReason,
  };
}
