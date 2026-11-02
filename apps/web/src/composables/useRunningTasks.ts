import { TaskStatus, type RunDto, type TaskDto } from '@libs/dto';

import { useResource } from '@/composables/useResource';

import { useTaskAdminService } from '@/services/api/admin/TaskAdminService';

export interface IRunningTask {
  task: TaskDto;
  /** The run in progress. Null between runs. */
  run: RunDto | null;
}

/** Every running task with its current run, newest first. Reads each task for its runs, as the list carries none. */
export const useRunningTasks = () => {
  const taskAdminService = useTaskAdminService();

  const fetchRunning = async (): Promise<IRunningTask[]> => {
    const filter = { status: TaskStatus.RUNNING };
    const firstPage = await taskAdminService.getTaskList(filter, 1);
    const laterPages = await Promise.all(
      Array.from({ length: Math.max(firstPage.pages - 1, 0) }, (_, index) =>
        taskAdminService.getTaskList(filter, index + 2)
      )
    );

    const listed = [firstPage, ...laterPages].flatMap(page => page.taskList);
    const tasks = await Promise.all(listed.map(task => taskAdminService.getTask(task.id)));

    return tasks.map(task => ({ task, run: [...task.runs].reverse().find(run => run.endDate === null) ?? null }));
  };

  return useResource({ request: {}, fetch: fetchRunning, live: true });
};
