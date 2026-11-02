import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';

import { ApiError, ApiErrorBase } from '@/types/api/error';

import { Config } from '@/Config';

import { useTelemetryStore } from '@/stores/telemetry';

import { IResourceOptions, useResource } from './useResource';

interface IJob {
  id: number;
  name: string;
}

const JOB: IJob = { id: 1, name: 'cleanup' };

let wrapper: ReturnType<typeof mount> | undefined;

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const mountResource = (options: IResourceOptions<number, IJob>) => {
  let resource: ReturnType<typeof useResource<number, IJob>> | undefined;

  wrapper = mount(
    defineComponent({
      setup() {
        resource = useResource(options);

        return () => null;
      },
    })
  );

  return resource!;
};

const fetchJob = (jobId: number): Promise<IJob> => Promise.resolve({ id: jobId, name: `job ${jobId}` });

describe('useResource', () => {
  it('loads the entity at once', async () => {
    const fetchMock = vi.fn(fetchJob);
    const resource = mountResource({ request: 1, fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(1);
    expect(resource.data.value).toBeNull();
    expect(resource.loading.value).toBe(true);

    await flushPromises();

    expect(resource.data.value).toEqual({ id: 1, name: 'job 1' });
    expect(resource.loading.value).toBe(false);
  });

  it('fetches nothing while the request is null, then loads once it is set', async () => {
    const fetchMock = vi.fn(fetchJob);
    const request = ref<number | null>(null);
    const resource = mountResource({ request, fetch: fetchMock });
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resource.loading.value).toBe(false);

    request.value = 2;
    await nextTick();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(2);
    expect(resource.data.value).toEqual({ id: 2, name: 'job 2' });
  });

  it('refetches when the request changes', async () => {
    const fetchMock = vi.fn(fetchJob);
    const request = ref(1);
    const resource = mountResource({ request, fetch: fetchMock });
    await flushPromises();

    request.value = 2;
    await nextTick();
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith(2);
    expect(resource.data.value).toEqual({ id: 2, name: 'job 2' });
  });

  it('keeps the latest entity when an earlier request answers last', async () => {
    let answerFirst: (job: IJob) => void = () => undefined;
    const fetchMock = vi
      .fn<(jobId: number) => Promise<IJob>>()
      .mockReturnValueOnce(new Promise(resolve => (answerFirst = resolve)))
      .mockImplementation(fetchJob);
    const request = ref(1);
    const resource = mountResource({ request, fetch: fetchMock });

    request.value = 2;
    await nextTick();
    await flushPromises();

    answerFirst(JOB);
    await flushPromises();

    expect(resource.data.value).toEqual({ id: 2, name: 'job 2' });
    expect(resource.loading.value).toBe(false);
  });

  it('settles reload once the entity lands', async () => {
    const fetchMock = vi.fn(fetchJob);
    const resource = mountResource({ request: 1, fetch: fetchMock });
    await flushPromises();
    fetchMock.mockResolvedValueOnce({ id: 1, name: 'renamed' });

    await resource.reload();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resource.data.value).toEqual({ id: 1, name: 'renamed' });
  });

  it('keeps the last entity and clears loading when a fetch fails, without rejecting reload', async () => {
    const fetchMock = vi.fn(fetchJob);
    const resource = mountResource({ request: 1, fetch: fetchMock });
    await flushPromises();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(resource.reload()).resolves.toBeUndefined();

    expect(resource.data.value).toEqual({ id: 1, name: 'job 1' });
    expect(resource.loading.value).toBe(false);
  });
});

describe('useResource live', () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    wrapper?.unmount();
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('re-fetches on the live interval without showing loading, and reports as live', async () => {
    const fetchMock = vi.fn(fetchJob);
    const resource = mountResource({ request: 1, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resource.loading.value).toBe(false);
    expect(useTelemetryStore().state).toBe('live');
  });

  it('pauses while the tab is hidden and refreshes as soon as it is shown again', async () => {
    const fetchMock = vi.fn(fetchJob);
    mountResource({ request: 1, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads as stale once a refresh fails, and idle once the page is gone', async () => {
    const fetchMock = vi.fn(fetchJob);
    mountResource({ request: 1, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS);

    expect(useTelemetryStore().state).toBe('stale');

    wrapper?.unmount();

    expect(useTelemetryStore().state).toBe('idle');
  });

  it('stops refreshing once the api refuses the request, as for a task that does not exist', async () => {
    const fetchMock = vi.fn(
      (): Promise<IJob> => Promise.reject(new ApiError(ApiErrorBase.BAD_REQUEST, "This task doesn't exist."))
    );
    mountResource({ request: 999999, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS * 3);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useTelemetryStore().state).toBe('idle');
  });

  it('refreshes again once a changed request succeeds after a refusal', async () => {
    const request = ref(999999);
    const fetchMock = vi.fn((jobId: number): Promise<IJob> => {
      return jobId === 999999 ? Promise.reject(new ApiError(ApiErrorBase.NOT_FOUND)) : fetchJob(jobId);
    });
    mountResource({ request, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    request.value = 1;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS);

    expect(fetchMock.mock.calls).toEqual([[999999], [1], [1]]);
    expect(useTelemetryStore().state).toBe('live');
  });

  it('keeps refreshing after a failure the api did not answer, such as a lost connection', async () => {
    const fetchMock = vi.fn(fetchJob);
    mountResource({ request: 1, fetch: fetchMock, live: true });
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockRejectedValueOnce(new ApiError(ApiErrorBase.NETWORK));
    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS * 2);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useTelemetryStore().state).toBe('live');
  });

  it('leaves a resource that is not live out of the live updates', async () => {
    const fetchMock = vi.fn(fetchJob);
    mountResource({ request: 1, fetch: fetchMock });
    await vi.advanceTimersByTimeAsync(Config.LIVE_REFRESH_MS * 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useTelemetryStore().state).toBe('idle');
  });
});
