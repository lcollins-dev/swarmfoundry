import { Injectable } from '@nestjs/common';

import {
  RunDto,
  TaskDto,
  TaskListQueryDto,
  TaskListResponseDto,
  TranscriptDirection,
  TranscriptQueryDto,
  TranscriptResponseDto,
} from '@libs/dto';

import { ConfigService } from '@/config/config.service';
import { TaskReadService } from '@/core/task/task-read.service';

import { toListTaskDto } from './utils/list-task.util';
import { toRunDto } from './utils/run.util';

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
      taskList: summaries.map(summary => toListTaskDto(summary)),
      pages: Math.ceil(total / pageSize),
      total,
    };
  }

  async getTask(taskId: number): Promise<TaskDto> {
    const summary = await this.taskReadService.findTaskWithThrow(taskId);
    const { task } = summary;

    return {
      ...toListTaskDto(summary),
      matchedIssue:
        task.issueLabels === null
          ? null
          : { labels: task.issueLabels, author: task.issueAuthor, assignees: task.issueAssignees ?? [] },
      change:
        task.changeKind === null || task.changeDate === null
          ? null
          : { kind: task.changeKind, date: task.changeDate, actor: task.changeActor },
      cron: task.cron,
      runs: (task.runs ?? []).map(run => toRunDto(run)),
    };
  }

  async getRun(runId: number): Promise<RunDto> {
    return toRunDto(await this.taskReadService.findRunWithThrow(runId));
  }

  async getTranscript(
    runId: number,
    query: TranscriptQueryDto,
    eventLimit = TRANSCRIPT_PAGE_EVENTS
  ): Promise<TranscriptResponseDto> {
    const limits = { types: query.types, eventLimit, lineLimit: TRANSCRIPT_PAGE_LINES };

    if (query.direction === TranscriptDirection.BACKWARD) {
      return this.taskReadService.readTranscriptBefore(runId, { ...limits, beforeLine: query.beforeLine ?? null });
    }

    return this.taskReadService.readTranscript(runId, { ...limits, fromLine: query.fromLine ?? 1 });
  }
}
