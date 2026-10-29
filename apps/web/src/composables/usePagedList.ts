import { computed, MaybeRefOrGetter, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';

import { Config } from '@/Config';

import { useResource } from '@/composables/useResource';

export interface IListPage<TItem> {
  list: TItem[];
  pages: number;
  total?: number;
}

interface IPageRequest<TRequest> {
  request: TRequest;
  page: number;
}

export interface IPagedListOptions<TRequest, TItem> {
  /** A change returns the list to its first page. A null request fetches nothing. */
  request: MaybeRefOrGetter<TRequest | null>;
  fetch: (request: TRequest, page: number) => Promise<IListPage<TItem>>;
  /** Set false for a request that changes on navigation rather than typing, so it fetches at once. */
  debounceRequest?: boolean;
}

export const usePagedList = <TRequest, TItem>(options: IPagedListOptions<TRequest, TItem>) => {
  const page = ref(1);
  // Boxed, since a ref of a bare generic type parameter reads as any to the linter.
  const appliedFilter = shallowRef({ request: toValue(options.request) });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelDebounce = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  // Changes both in one tick, so the reset to page 1 does not fetch the old request.
  const applyRequest = () => {
    cancelDebounce();

    appliedFilter.value = { request: toValue(options.request) };
    page.value = 1;
  };

  watch(
    () => toValue(options.request),
    () => {
      if (options.debounceRequest === false) {
        applyRequest();

        return;
      }

      cancelDebounce();

      debounceTimer = setTimeout(applyRequest, Config.LIST_DEBOUNCE_MS);
    },
    { deep: true }
  );

  onScopeDispose(cancelDebounce);

  const {
    data,
    loading,
    reload: load,
  } = useResource({
    request: computed<IPageRequest<TRequest> | null>(() => {
      const { request } = appliedFilter.value;

      return request === null ? null : { request, page: page.value };
    }),
    fetch: (pageRequest: IPageRequest<TRequest>) => options.fetch(pageRequest.request, pageRequest.page),
  });

  const list = computed(() => data.value?.list ?? []);
  const pages = computed(() => data.value?.pages ?? 1);
  const total = computed(() => data.value?.total ?? 0);

  return { list, page, pages, total, loading, load };
};
