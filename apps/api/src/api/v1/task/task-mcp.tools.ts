import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TaskStatus } from '@libs/dto';

import { McpTools } from '@/api/mcp/decorators/mcp-tools.decorator';

import { TaskAdminService } from './task-admin.service';

import { MCP_FILTER_MAX_LENGTH, MCP_ID_MAX, mcpId } from '@/api/mcp/schema/tool-fields';
import type { IMcpToolProvider } from '@/api/mcp/types/mcp.types';
import { registerReadTool } from '@/api/mcp/utils/read-tool.util';

@Injectable()
@McpTools()
export class TaskMcpTools implements IMcpToolProvider {
  constructor(private readonly taskAdminService: TaskAdminService) {}

  register(server: McpServer): void {
    registerReadTool(
      server,
      'list_tasks',
      {
        title: 'List tasks',
        description:
          'Lists tasks newest first, one page at a time, with their run totals. A task is one trigger firing on ' +
          'an issue, a merge request or a schedule, and runs its steps as runs.',
        inputSchema: {
          page: z.int().min(1).max(MCP_ID_MAX).default(1),
          status: z.enum(TaskStatus).optional(),
          trigger: z.string().min(1).max(MCP_FILTER_MAX_LENGTH).optional().describe("The trigger's name, exactly."),
          project: z.string().min(1).max(MCP_FILTER_MAX_LENGTH).optional().describe('The project path, in any case.'),
        },
      },
      args => this.taskAdminService.getTaskList(args)
    );

    registerReadTool(
      server,
      'get_task',
      {
        title: 'Get a task',
        description: 'Returns a task with the issue it matched, the change it matched on and its runs in start order.',
        inputSchema: { taskId: mcpId() },
      },
      ({ taskId }) => this.taskAdminService.getTask(taskId)
    );

    registerReadTool(
      server,
      'get_run',
      {
        title: 'Get a run',
        description:
          'Returns one run: its step, outcome, end reason, error, agent, config revision, turns, tokens and cost.',
        inputSchema: { runId: mcpId() },
      },
      ({ runId }) => this.taskAdminService.getRun(runId)
    );
  }
}
