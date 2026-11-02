import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskStatus } from '@libs/dto';

import type { TaskAdminService } from './task-admin.service';

import { TaskMcpTools } from './task-mcp.tools';
import { connectTestClient, type IMcpTestClient } from '@/api/mcp/utils/mcp-test-client.util';

const taskAdminService = { getTaskList: vi.fn(), getTask: vi.fn(), getRun: vi.fn() };

describe('TaskMcpTools', () => {
  let mcp: IMcpTestClient;

  beforeEach(async () => {
    vi.clearAllMocks();

    mcp = await connectTestClient([new TaskMcpTools(taskAdminService as unknown as TaskAdminService)]);
  });

  it('answers list_tasks from the read API, from the first page by default', async () => {
    taskAdminService.getTaskList.mockResolvedValue({ taskList: [], pages: 0, total: 0 });

    expect(await mcp.call('list_tasks', { status: TaskStatus.FAILED, trigger: 'implement' })).toEqual({
      result: { taskList: [], pages: 0, total: 0 },
    });
    expect(taskAdminService.getTaskList).toHaveBeenCalledWith({
      page: 1,
      status: TaskStatus.FAILED,
      trigger: 'implement',
    });
  });

  it('answers get_task and get_run from the read API', async () => {
    taskAdminService.getTask.mockResolvedValue({ id: 4 });
    taskAdminService.getRun.mockResolvedValue({ id: 9 });

    expect(await mcp.call('get_task', { taskId: 4 })).toEqual({ result: { id: 4 } });
    expect(await mcp.call('get_run', { runId: 9 })).toEqual({ result: { id: 9 } });
    expect(taskAdminService.getTask).toHaveBeenCalledWith(4);
    expect(taskAdminService.getRun).toHaveBeenCalledWith(9);
  });
});
