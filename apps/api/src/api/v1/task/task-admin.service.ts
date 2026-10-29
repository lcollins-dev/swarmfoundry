import { Injectable } from '@nestjs/common';

import {
  ListTaskDto,
  RunDto,
  TaskDto,
  TaskListQueryDto,
  TaskListResponseDto,
  TranscriptQueryDto,
  TranscriptResponseDto,
} from '@libs/dto';

import { Run } from '@/core/task/entities/run.entity';

import { ConfigService } from '@/config/config.service';
import { TaskReadService, type ITaskSummary } from '@/core/task/task-read.service';

import { taskKindOf } from '@/core/task/task-kind';

/** A page reads whole lines until it holds this many events. */
export const TRANSCRIPT_PAGE_EVENTS = 200;

/** A page reads no more lines than this, so a filter that matches little answers early. */
export const TRANSCRIPT_PAGE_LINES = 2000;

@Injectable()
export class TaskAdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly taskReadService: TaskReadService
  ) {}

  async getTaskList(query: TaskListQueryDto): Promise<TaskListResponseDto> {
    const pageSize = this.configService.pageSize;

    const [summaries, total] = await this.taskReadService.findTasks(
      { status: query.status, triggerName: query.trigger, projectPath: query.project },
      pageSize * (query.page - 1),
      pageSize
    );

    return {
      taskList: summaries.map(summary => this.toListTask(summary)),
      pages: Math.ceil(total / pageSize),
      total,
    };
  }

  async getTask(taskId: number): Promise<TaskDto> {
    const summary = await this.taskReadService.findTaskWithThrow(taskId);
    const { task } = summary;

    return {
      ...this.toListTask(summary),
      matchedIssue:
        task.issueLabels === null
          ? null
          : { labels: task.issueLabels, author: task.issueAuthor, assignees: task.issueAssignees ?? [] },
      change:
        task.changeKind === null || task.changeDate === null
          ? null
          : { kind: task.changeKind, date: task.changeDate, actor: task.changeActor },
      cron: task.cron,
      runs: (task.runs ?? []).map(run => this.toRun(run)),
    };
  }

  async getRun(runId: number): Promise<RunDto> {
    return this.toRun(await this.taskReadService.findRunWithThrow(runId));
  }

  async getTranscript(runId: number, query: TranscriptQueryDto): Promise<TranscriptResponseDto> {
    return this.taskReadService.readTranscript(runId, {
      fromLine: query.fromLine,
      types: query.types,
      eventLimit: TRANSCRIPT_PAGE_EVENTS,
      lineLimit: TRANSCRIPT_PAGE_LINES,
    });
  }

  private toListTask({ task, totals }: ITaskSummary): ListTaskDto {
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

  private toRun(run: Run): RunDto {
    return {
      id: run.id,
      taskId: run.taskId,
      list: run.list,
      step: run.step,
      number: run.number,
      outcome: run.outcome,
      endReason: run.endReason,
      exitCode: run.exitCode,
      configSha: run.config?.sha ?? null,
      startDate: run.startDate,
      endDate: run.endDate,
      error: run.error,
      agent:
        run.agentName === null || run.agentModel === null || run.agentAuth === null
          ? null
          : { name: run.agentName, model: run.agentModel, auth: run.agentAuth },
      turns: run.turns,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      costUsd: run.costUsd,
    };
  }
}
