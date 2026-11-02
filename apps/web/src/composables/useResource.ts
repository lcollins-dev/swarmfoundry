import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import { MaybeRefOrGetter, getCurrentScope, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';

import { ApiError } from '@/types/api/error';

import { Config } from '@/Config';

import { useLogService } from '@/services/LogService';
import { useTelemetryStore } from '@/stores/telemetry';

export interface IResourceOptions<TRequest, TData> {
  /** A change refetches. A null request fetches nothing. */
  request: MaybeRefOrGetter<TRequest | null>;
  fetch: (request: TRequest) => Promise<TData>;
  /**
   * Re-fetches every `Config.LIVE_REFRESH_MS` while the tab is visible, and reports to the live updates tag, until the
   * api refuses the request.
   */
  live?: boolean;
}

export const useResource = <TRequest, TData>(options: IResourceOptions<TRequest, TData>) => {
  const logService = useLogService();
  const logger = logService.createLogger('composables/useResource');

  const data = shallowRef<TData | null>(null);
  const loading = ref(false);

  const connected = ref(false);
  const lastActivityDate = ref<Date | null>(null);

  const refused = ref(false);

  let latestFetch = 0;
  let refreshing = false;

  // Lands the result only if no later fetch has started since. Settles with the fetch and never rejects.
  // A background fetch leaves `loading` alone, so a live refresh shows no spinner.
  const fetchLatest = (background: boolean): Promise<void> => {
    const request = toValue(options.request);

    if (request === null) {
      return Promise.resolve();
    }

    const fetchId = ++latestFetch;

    if (!background) {
      loading.value = true;
    }

    return options
      .fetch(request)
      .then(result => {
        if (fetchId === latestFetch) {
          data.value = result;
          refused.value = false;
        }

        connected.value = true;
        lastActivityDate.value = new Date();
      })
      .finally(() => {
        if (fetchId === latestFetch) {
          loading.value = false;
        }
      })
      .catch((error: unknown) => {
        connected.value = false;

        if (fetchId === latestFetch && error instanceof ApiError && error.refused) {
          refused.value = true;
        }

        logger.error({ error }, 'fetchLatest(): Failed to fetch');
      });
  };

  const reload = (): Promise<void> => fetchLatest(false);

  watch(
    () => toValue(options.request),
    () => void reload(),
    { deep: true }
  );

  void reload();

  if (options.live === true && getCurrentScope() !== undefined) {
    const telemetryStore = useTelemetryStore();
    const visibility = useDocumentVisibility();

    const refresh = () => {
      if (refreshing || refused.value || visibility.value !== 'visible') {
        return;
      }

      refreshing = true;

      void fetchLatest(true).finally(() => {
        refreshing = false;
      });
    };

    useIntervalFn(refresh, Config.LIVE_REFRESH_MS);

    watch(visibility, () => refresh());

    // A refused request leaves the live updates tag, so it reads idle rather than stale.
    let unregister: (() => void) | null = telemetryStore.register({ connected, lastActivityDate });

    watch(refused, isRefused => {
      if (isRefused) {
        unregister?.();
        unregister = null;
      } else {
        unregister ??= telemetryStore.register({ connected, lastActivityDate });
      }
    });

    onScopeDispose(() => unregister?.());
  }

  return { data, loading, reload };
};
