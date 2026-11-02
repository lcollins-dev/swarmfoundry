import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { RunEndReason, RunOutcome, StepList, TaskStatus, type TaskDto } from '@libs/dto';

import { runWith, taskWith } from '../../../../test/factories/task.factory';
import Task from './Task.vue';

const getTask = vi.fn<(taskId: number) => Promise<TaskDto>>();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({ getTask }),
}));

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/tasks/:taskId', component: { template: '<div />' } }],
  });
  await router.push('/tasks/1080');

  const wrapper = mount(Task, { global: { plugins: [router] } });
  await flushPromises();

  return wrapper;
};

const failedTry = (id: number, number: number, error: string) =>
  runWith({
    id,
    number,
    outcome: RunOutcome.FAILED,
    endReason: RunEndReason.ERROR,
    endDate: new Date('2026-10-25T09:10:00Z'),
    error,
  });

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('Task page', () => {
  it('shows what triggered an issue task, linked on GitLab, with the issue as matched', async () => {
    getTask.mockResolvedValue(taskWith());

    const wrapper = await mountPage();

    expect(getTask).toHaveBeenCalledWith(1080);

    const issueLinks = wrapper.findAll('a').filter(link => link.attributes('href') === taskWith().issue!.url);

    expect(issueLinks.map(link => link.text())).toEqual(['Open in GitLab', '#214']);
    expect(wrapper.text()).toContain('workflow::ready');
    expect(wrapper.text()).toContain('ann');
    expect(wrapper.text()).toContain('foundry-bot');
    expect(wrapper.text()).toMatch(/ChangeLabelled\s*Changed byann/);
  });

  it('shows a scheduled task by its schedule, with no GitLab link', async () => {
    getTask.mockResolvedValue(
      taskWith({
        kind: 'schedule',
        issue: null,
        matchedIssue: null,
        change: null,
        triggerName: 'dependency-audit',
        cron: '0 3 * * 1',
        fireTime: new Date('2026-10-26T03:00:00Z'),
      })
    );

    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('Scheduled · dependency-audit');
    expect(wrapper.text()).toContain('0 3 * * 1');
    expect(wrapper.text()).not.toContain('Open in GitLab');
  });

  it('groups runs by step with their tries, and names the try that failed the task', async () => {
    getTask.mockResolvedValue(
      taskWith({
        status: TaskStatus.FAILED,
        runs: [
          failedTry(1, 1, 'Tests kept failing.'),
          failedTry(2, 2, 'Container failed to start.'),
          runWith({ id: 3, list: StepList.FAILURE_STEPS, outcome: RunOutcome.SUCCEEDED, agent: null }),
        ],
      })
    );

    const wrapper = await mountPage();

    expect(wrapper.findAll('[data-testid="step-group"]').map(group => group.text())).toEqual([
      'Step 1',
      'Failure step 1',
    ]);

    const runs = wrapper.findAll('[data-testid="task-run"]');

    expect(runs.map(run => run.attributes('href'))).toEqual(['/runs/1', '/runs/2', '/runs/3']);
    expect(runs[1].text()).toContain('Try 2');
    expect(runs[1].text()).toContain('Error');

    const failure = wrapper.get('[data-testid="task-failure"]');

    expect(failure.text()).toContain('Task failed');
    expect(failure.text()).toContain('Container failed to start.');
  });
});
