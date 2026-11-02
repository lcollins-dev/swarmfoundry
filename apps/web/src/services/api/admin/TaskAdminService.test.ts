import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RunDto,
  TaskDto,
  TaskListResponseDto,
  TaskStatus,
  TranscriptEventType,
  TranscriptResponseDto,
  TranscriptStreamMessageDto,
} from '@libs/dto';

import { RequestType } from '@/types/api';
import { ApiError, ApiErrorBase } from '@/types/api/error';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';
import { useSseService } from '../SseService';
import { useTaskAdminService } from './TaskAdminService';

vi.mock('../ApiService', () => ({
  useApiService: vi.fn(),
}));

vi.mock('../SseService', () => ({
  useSseService: vi.fn(),
}));

vi.mock('../../ErrorService', () => ({
  useErrorService: vi.fn(),
}));

const TOKEN_OPTIONS = { token: 'signed-jwt' };

describe('useTaskAdminService', () => {
  let makeRequestMock: ReturnType<typeof vi.fn>;
  let handleErrorMock: ReturnType<typeof vi.fn>;
  let clearAllNotificationsMock: ReturnType<typeof vi.fn<() => void>>;
  let subscribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());

    makeRequestMock = vi.fn().mockResolvedValue(undefined);
    handleErrorMock = vi.fn((error: unknown) => {
      throw error;
    });
    clearAllNotificationsMock = vi.fn<() => void>();
    subscribeMock = vi.fn();

    vi.mocked(useApiService).mockReturnValue({
      makeRequest: makeRequestMock,
    } as unknown as ReturnType<typeof useApiService>);
    vi.mocked(useSseService).mockReturnValue({
      subscribe: subscribeMock,
    } as unknown as ReturnType<typeof useSseService>);
    vi.mocked(useErrorService).mockReturnValue({
      handleError: handleErrorMock,
    } as unknown as ReturnType<typeof useErrorService>);

    useNotificationStore().clearAllNotifications = clearAllNotificationsMock;
    useUserStore().setToken('signed-jwt');
  });

  it('reads a page of tasks with each filter set, encoded', async () => {
    makeRequestMock.mockResolvedValue({ taskList: [], pages: 0, total: 0 });

    await useTaskAdminService().getTaskList(
      { status: TaskStatus.FAILED, trigger: 'implement', project: 'group/sub project' },
      2
    );

    expect(makeRequestMock).toHaveBeenCalledWith(
      'admin/task/list?page=2&status=failed&trigger=implement&project=group%2Fsub+project',
      RequestType.GET,
      { ...TOKEN_OPTIONS, response: TaskListResponseDto }
    );
  });

  it('leaves out a filter that is not set', async () => {
    makeRequestMock.mockResolvedValue({ taskList: [], pages: 0, total: 0 });

    await useTaskAdminService().getTaskList({ trigger: undefined }, 1);

    expect(makeRequestMock).toHaveBeenCalledWith('admin/task/list?page=1', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: TaskListResponseDto,
    });
  });

  it('reads a task and a run by id', async () => {
    await useTaskAdminService().getTask(4);
    await useTaskAdminService().getRun(9);

    expect(makeRequestMock).toHaveBeenCalledWith('admin/task/4', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: TaskDto,
    });
    expect(makeRequestMock).toHaveBeenCalledWith('admin/run/9', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: RunDto,
    });
  });

  it("reads the page of a run's transcript before a line, of the given types, without clearing the toasts", async () => {
    await useTaskAdminService().getTranscript(9, 41, [TranscriptEventType.TOOL_CALL, TranscriptEventType.TOOL_RESULT]);

    expect(makeRequestMock).toHaveBeenCalledWith(
      'admin/run/9/transcript?direction=backward&beforeLine=41&types=toolCall%2CtoolResult',
      RequestType.GET,
      { ...TOKEN_OPTIONS, response: TranscriptResponseDto }
    );
    expect(clearAllNotificationsMock).not.toHaveBeenCalled();
  });

  it('reads the last page of every type when no line or type is given', async () => {
    await useTaskAdminService().getTranscript(9, null);

    expect(makeRequestMock).toHaveBeenCalledWith('admin/run/9/transcript?direction=backward', RequestType.GET, {
      ...TOKEN_OPTIONS,
      response: TranscriptResponseDto,
    });
  });

  it("follows a run's transcript of the given types from the line after the last one held", () => {
    const onMessage = vi.fn();
    const onRefusal = vi.fn();

    useTaskAdminService().followTranscript(9, 41, [TranscriptEventType.TOOL_CALL], onMessage, onRefusal);

    expect(subscribeMock).toHaveBeenCalledWith(
      'admin/run/9/transcript/stream?types=toolCall',
      TranscriptStreamMessageDto,
      onMessage,
      { ...TOKEN_OPTIONS, lastEventId: '41', onRefusal }
    );
  });

  it('follows every type when none is given', () => {
    useTaskAdminService().followTranscript(9, 0, [], vi.fn(), vi.fn());

    expect(subscribeMock).toHaveBeenCalledWith(
      'admin/run/9/transcript/stream',
      TranscriptStreamMessageDto,
      expect.any(Function),
      expect.objectContaining({ lastEventId: '0' })
    );
  });

  it('hands a failure to the error service', async () => {
    makeRequestMock.mockRejectedValue(new ApiError(ApiErrorBase.NOT_FOUND));

    await expect(useTaskAdminService().getTask(4)).rejects.toThrow();

    expect(handleErrorMock).toHaveBeenCalled();
    expect(clearAllNotificationsMock).not.toHaveBeenCalled();
  });
});
