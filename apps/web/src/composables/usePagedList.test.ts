import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';

import { Config } from '@/Config';

import { IListPage, IPagedListOptions, usePagedList } from './usePagedList';

interface IRequest {
  search?: string;
}

const PAGE: IListPage<string> = { list: ['first', 'second'], pages: 3 };

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('usePagedList', () => {
  let fetchMock: ReturnType<typeof vi.fn<(request: IRequest, page: number) => Promise<IListPage<string>>>>;

  const mountList = (options: Partial<IPagedListOptions<IRequest, string>> = {}) => {
    let pagedList: ReturnType<typeof usePagedList<IRequest, string>> | undefined;

    const wrapper = mount(
      defineComponent({
        setup() {
          pagedList = usePagedList<IRequest, string>({ request: {}, fetch: fetchMock, ...options });

          return () => null;
        },
      })
    );

    return { wrapper, pagedList: pagedList! };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fetchMock = vi.fn<(request: IRequest, page: number) => Promise<IListPage<string>>>().mockResolvedValue(PAGE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => {
    const pending = flushPromises();

    await vi.advanceTimersByTimeAsync(0);
    await pending;
  };

  it('loads the first page on mount', async () => {
    const { pagedList } = mountList({ request: { search: 'admin' } });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({ search: 'admin' }, 1);
    expect(pagedList.loading.value).toBe(true);

    await settle();

    expect(pagedList.list.value).toEqual(PAGE.list);
    expect(pagedList.pages.value).toBe(3);
    expect(pagedList.loading.value).toBe(false);
  });

  it('reports the total the page carries', async () => {
    fetchMock.mockResolvedValue({ ...PAGE, total: 25 });
    const { pagedList } = mountList();

    expect(pagedList.total.value).toBe(0);

    await settle();

    expect(pagedList.total.value).toBe(25);
  });

  it('fetches a page change at once', async () => {
    const { pagedList } = mountList();
    await settle();
    fetchMock.mockClear();

    pagedList.page.value = 2;
    await nextTick();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({}, 2);
  });

  it('returns to the first page on a request change and fetches it once, after the debounce', async () => {
    const request = ref<IRequest>({});
    const { pagedList } = mountList({ request });
    await settle();

    pagedList.page.value = 3;
    await nextTick();
    fetchMock.mockClear();

    request.value = { search: 'a' };
    await nextTick();
    request.value = { search: 'ad' };
    await nextTick();

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);

    expect(pagedList.page.value).toBe(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({ search: 'ad' }, 1);
  });

  it('fetches a page change after a request change made on the first page', async () => {
    const request = ref<IRequest>({});
    const { pagedList } = mountList({ request });
    await settle();

    request.value = { search: 'admin' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);
    fetchMock.mockClear();

    pagedList.page.value = 2;
    await nextTick();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({ search: 'admin' }, 2);
  });

  it('fetches nothing while the request is null', async () => {
    const request = ref<IRequest | null>(null);
    mountList({ request });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();

    request.value = { search: 'admin' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({ search: 'admin' }, 1);
  });

  it('clears loading when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { pagedList } = mountList();

    await settle();

    expect(pagedList.loading.value).toBe(false);
    expect(pagedList.list.value).toEqual([]);
  });

  it('loads the current page at once, then applies a pending request change after the debounce', async () => {
    const request = ref<IRequest>({});
    const { pagedList } = mountList({ request });
    await settle();
    fetchMock.mockClear();

    request.value = { search: 'admin' };
    await nextTick();
    void pagedList.load();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({}, 1);

    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);

    expect(fetchMock).toHaveBeenLastCalledWith({ search: 'admin' }, 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('settles the load promise once the rows land, without rejecting on a failed fetch', async () => {
    const { pagedList } = mountList();
    await settle();
    fetchMock.mockResolvedValueOnce({ list: ['reloaded'], pages: 1 });

    await pagedList.load();

    expect(pagedList.list.value).toEqual(['reloaded']);

    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(pagedList.load()).resolves.toBeUndefined();
  });

  it('shows the loader while a page change fetches', async () => {
    const { pagedList } = mountList();
    await settle();
    fetchMock.mockReturnValue(new Promise(() => undefined));

    pagedList.page.value = 2;
    await nextTick();

    expect(pagedList.loading.value).toBe(true);
  });

  it('shows the loader while a request change fetches', async () => {
    const request = ref<IRequest>({});
    const { pagedList } = mountList({ request });
    await settle();
    fetchMock.mockReturnValue(new Promise(() => undefined));

    request.value = { search: 'admin' };
    await nextTick();
    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);

    expect(pagedList.loading.value).toBe(true);
  });

  it('drops a request change still pending at unmount', async () => {
    const request = ref<IRequest>({});
    const { wrapper } = mountList({ request });
    await settle();
    fetchMock.mockClear();

    request.value = { search: 'admin' };
    await nextTick();
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(Config.LIST_DEBOUNCE_MS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the latest page when an earlier one answers last', async () => {
    const { pagedList } = mountList();
    await settle();

    let answerPageTwo: (page: IListPage<string>) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise(resolve => (answerPageTwo = resolve)));
    fetchMock.mockResolvedValueOnce({ list: ['page three'], pages: 3 });

    pagedList.page.value = 2;
    await nextTick();
    pagedList.page.value = 3;
    await nextTick();
    await settle();

    answerPageTwo({ list: ['page two'], pages: 3 });
    await settle();

    expect(pagedList.list.value).toEqual(['page three']);
    expect(pagedList.loading.value).toBe(false);
  });

  it('fetches a request change at once, from the first page, when told not to debounce it', async () => {
    const request = ref<IRequest>({ search: 'job 1' });
    const { pagedList } = mountList({ request, debounceRequest: false });
    await settle();

    pagedList.page.value = 3;
    await nextTick();
    fetchMock.mockClear();

    request.value = { search: 'job 2' };
    await nextTick();
    await nextTick();

    expect(pagedList.page.value).toBe(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith({ search: 'job 2' }, 1);
  });
});
