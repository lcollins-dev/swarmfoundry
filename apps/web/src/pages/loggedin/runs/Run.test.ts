import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import {
  RunEndReason,
  RunOutcome,
  TranscriptEventType,
  type RunDto,
  type TranscriptResponseDto,
  type TranscriptStreamMessageDto,
} from '@libs/dto';

import { runWith, taskWith } from '../../../../test/factories/task.factory';
import Run from './Run.vue';

const getRun = vi.fn<(runId: number) => Promise<RunDto>>();
const getTranscript = vi.fn<() => Promise<TranscriptResponseDto>>();
const followTranscript =
  vi.fn<
    (
      runId: number,
      afterLine: number,
      types: TranscriptEventType[],
      onMessage: (message: TranscriptStreamMessageDto) => void
    ) => { close: () => void }
  >();

vi.mock('@/services/api/admin/TaskAdminService', () => ({
  useTaskAdminService: () => ({
    getRun,
    getTask: () => Promise.resolve(taskWith()),
    getTranscript,
    followTranscript,
  }),
}));

const ENDED_RUN = runWith({
  outcome: RunOutcome.FAILED,
  endReason: RunEndReason.TIMEOUT,
  exitCode: 1,
  endDate: new Date('2026-10-25T09:27:20Z'),
  error: 'Step exceeded its timeout and was stopped.',
  turns: 41,
  inputTokens: 324_000,
  outputTokens: 46_000,
  cacheReadTokens: 1_330_000,
  cacheWriteTokens: 0,
  costUsd: 13.04,
});

const mountPage = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/runs/:runId', component: { template: '<div />' } }],
  });
  await router.push('/runs/3405');

  const wrapper = mount(Run, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();

  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());

  getRun.mockReset();
  getTranscript
    .mockReset()
    .mockResolvedValue({ events: [], firstLine: 1, hasEarlier: false, nextLine: 1, hasMore: false });
  followTranscript.mockReset().mockReturnValue({ close: () => undefined });
});

describe('Run page', () => {
  it('shows its outcome, end reason, exit code, error, revision, try, turns and tokens by kind', async () => {
    getRun.mockResolvedValue(ENDED_RUN);

    const wrapper = await mountPage();

    expect(getRun).toHaveBeenCalledWith(3405);
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('Failed');
    expect(wrapper.get('[data-testid="run-end-reason"]').text()).toContain('Timeout');
    expect(wrapper.get('[data-testid="run-error"]').text()).toContain('Step exceeded its timeout and was stopped.');
    expect(wrapper.text()).toContain('a41c9e2f');
    expect(wrapper.text()).toContain('Try 1');
    expect(wrapper.text()).toContain('41');

    const tokens = wrapper.get('[data-testid="run-tokens"]').text();

    expect(tokens).toContain('1,700,000');
    expect(wrapper.text()).toMatch(/Input tokens324k\s*Output tokens46k\s*Cache read1\.3M\s*Cache write0/);

    const cost = wrapper.get('[data-testid="run-cost"]').text();

    expect(cost).toContain('$13.04');
    expect(cost).toContain('API cost');
  });

  it('shows its error as a notice above the outcome, and none without one', async () => {
    getRun.mockResolvedValueOnce(ENDED_RUN);

    const wrapper = await mountPage();
    const notice = wrapper.get('[data-testid="run-error"]');

    expect(notice.attributes('role')).toBe('alert');
    expect(wrapper.text().indexOf('Step exceeded its timeout')).toBeLessThan(wrapper.text().indexOf('Outcome'));

    getRun.mockResolvedValueOnce(runWith());

    const running = await mountPage();

    expect(running.find('[data-testid="run-error"]').exists()).toBe(false);
  });

  it('links back to its task', async () => {
    getRun.mockResolvedValue(ENDED_RUN);

    const wrapper = await mountPage();

    const back = wrapper.findAll('a').find(link => link.attributes('href') === '/tasks/1080');

    expect(back?.text()).toBe('group/project#214 · implement · Task 1080');
  });

  it('follows a running run, appending its new events, then shows the outcome once it ends', async () => {
    const close = vi.fn();
    getRun.mockResolvedValueOnce(runWith()).mockResolvedValueOnce(ENDED_RUN);
    followTranscript.mockReturnValue({ close });

    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('Running');
    expect(followTranscript).toHaveBeenCalledWith(3405, 0, [], expect.any(Function), expect.any(Function));

    const onMessage = followTranscript.mock.calls[0][3];

    onMessage({
      type: 'line',
      lineNumber: 1,
      events: [
        {
          type: TranscriptEventType.ASSISTANT_TEXT,
          lineNumber: 1,
          index: 0,
          storedDate: new Date('2026-10-25T09:04:00Z'),
          parentToolUseId: null,
          text: 'Reading the ticket.',
        },
      ],
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Reading the ticket.');

    onMessage({ type: 'end' });
    await flushPromises();

    expect(close).toHaveBeenCalledOnce();
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('Failed');
    expect(wrapper.get('[data-testid="run-cost"]').text()).toContain('$13.04');
    expect(wrapper.text()).toContain('Reading the ticket.');
    expect(getTranscript).toHaveBeenCalledOnce();
  });

  it('serves a finished run without following it', async () => {
    getRun.mockResolvedValue(ENDED_RUN);

    await mountPage();

    expect(followTranscript).not.toHaveBeenCalled();
  });
});
