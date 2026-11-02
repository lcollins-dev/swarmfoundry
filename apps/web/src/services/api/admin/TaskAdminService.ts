import {
  RunDto,
  TaskDto,
  TaskListResponseDto,
  TranscriptDirection,
  TranscriptResponseDto,
  TranscriptStreamMessageDto,
  type TaskListQueryDto,
  type TranscriptEventType,
} from '@libs/dto';

import { RequestType } from '@/types/api';

import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { useErrorService } from '../../ErrorService';
import { useApiService } from '../ApiService';
import { type ISseRefusal, type ISseSubscription, useSseService } from '../SseService';

export type TaskListFilter = Omit<TaskListQueryDto, 'page'>;

export const useTaskAdminService = () => {
  const apiService = useApiService();
  const sseService = useSseService();
  const errorService = useErrorService();

  const userStore = useUserStore();
  const notificationStore = useNotificationStore();

  async function getTaskList(filter: TaskListFilter, page: number): Promise<TaskListResponseDto> {
    const query = new URLSearchParams({ page: String(page) });

    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === 'string') {
        query.set(key, value);
      }
    }

    const taskList = await apiService
      .makeRequest(`admin/task/list?${query.toString()}`, RequestType.GET, {
        response: TaskListResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return taskList;
  }

  async function getTask(taskId: number): Promise<TaskDto> {
    const task = await apiService
      .makeRequest(`admin/task/${taskId}`, RequestType.GET, {
        response: TaskDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return task;
  }

  async function getRun(runId: number): Promise<RunDto> {
    const run = await apiService
      .makeRequest(`admin/run/${runId}`, RequestType.GET, {
        response: RunDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    notificationStore.clearAllNotifications();

    return run;
  }

  /**
   * Reads the page before `beforeLine`, or the last page when null. Leaves the toasts alone, as the run page reads it
   * page by page while the user scrolls.
   */
  async function getTranscript(
    runId: number,
    beforeLine: number | null,
    types: TranscriptEventType[] = []
  ): Promise<TranscriptResponseDto> {
    const query = new URLSearchParams({ direction: TranscriptDirection.BACKWARD });

    if (beforeLine !== null) {
      query.set('beforeLine', String(beforeLine));
    }

    if (types.length > 0) {
      query.set('types', types.join(','));
    }

    const transcript = await apiService
      .makeRequest(`admin/run/${runId}/transcript?${query.toString()}`, RequestType.GET, {
        response: TranscriptResponseDto,
        token: userStore.token,
      })
      .catch((error: unknown) => errorService.handleError(error));

    return transcript;
  }

  /** Streams each line stored after `afterLine` with the events `types` keeps, then an end message once the run ends. */
  function followTranscript(
    runId: number,
    afterLine: number,
    types: TranscriptEventType[],
    onMessage: (message: TranscriptStreamMessageDto) => void,
    onRefusal: (refusal: ISseRefusal) => void
  ): ISseSubscription {
    const query = types.length > 0 ? `?${new URLSearchParams({ types: types.join(',') }).toString()}` : '';

    return sseService.subscribe(`admin/run/${runId}/transcript/stream${query}`, TranscriptStreamMessageDto, onMessage, {
      token: userStore.token,
      lastEventId: String(afterLine),
      onRefusal,
    });
  }

  return {
    getTaskList,
    getTask,
    getRun,
    getTranscript,
    followTranscript,
  };
};
