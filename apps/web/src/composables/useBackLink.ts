import { MaybeRefOrGetter, computed, toValue } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { type IBackLink, backLinkTo } from '@/utils/backLink';

/**
 * Leads back to the console page the user came from, so a task opened from the queue returns to the queue.
 * Falls back to the page's parent after a reload or a link from outside the console.
 */
export const useBackLink = (parent: MaybeRefOrGetter<IBackLink>) => {
  const route = useRoute();
  const router = useRouter();

  return computed<IBackLink>(() => {
    // Read so the link follows each navigation, as the history state itself is not reactive.
    void route.fullPath;

    const fallback = toValue(parent);
    const back: unknown = router.options.history.state.back;
    const previous = typeof back === 'string' ? backLinkTo(back) : null;

    if (previous === null) {
      return fallback;
    }

    return previous.to === fallback.to ? fallback : previous;
  });
};
