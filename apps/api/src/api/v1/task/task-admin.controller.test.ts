import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskStatus } from '@libs/dto';

import { TaskAdminService } from '@/api/v1/task/task-admin.service';

import { TaskAdminController } from '@/api/v1/task/task-admin.controller';

describe('TaskAdminController', () => {
  let controller: TaskAdminController;
  let getTaskListMock: ReturnType<typeof vi.fn>;
  let getTaskMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getTaskListMock = vi.fn();
    getTaskMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [TaskAdminController],
      providers: [{ provide: TaskAdminService, useValue: { getTaskList: getTaskListMock, getTask: getTaskMock } }],
    }).compile();

    controller = moduleRef.get(TaskAdminController);
  });

  it('passes the parsed query through when listing tasks', async () => {
    getTaskListMock.mockResolvedValue({ taskList: [], pages: 0, total: 0 });
    const query = { page: 2, status: TaskStatus.FAILED };

    const response = await controller.getTaskList(query);

    expect(getTaskListMock).toHaveBeenCalledWith(query);
    expect(response).toEqual({ taskList: [], pages: 0, total: 0 });
  });

  it('passes the parsed id through when fetching a task', async () => {
    getTaskMock.mockResolvedValue({ id: 5 });

    await controller.getTask(5);

    expect(getTaskMock).toHaveBeenCalledWith(5);
  });
});
