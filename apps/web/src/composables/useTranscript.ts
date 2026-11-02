import { MaybeRefOrGetter, getCurrentScope, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';

import type {
  TranscriptEventDto,
  TranscriptEventType,
  TranscriptResponseDto,
  TranscriptStreamMessageDto,
} from '@libs/dto';

import { useLogService } from '@/services/LogService';

export interface ITranscriptRequest {
  runId: number;
  /** Every type when empty. */
  types: TranscriptEventType[];
}

export interface ITranscriptFollowHandlers {
  onMessage: (message: TranscriptStreamMessageDto) => void;
  /** The stream has closed for good without an end message, such as on a refusal. */
  onStop: () => void;
}

export interface ITranscriptOptions {
  /** A change starts again from the last page. A null request fetches nothing. */
  request: MaybeRefOrGetter<ITranscriptRequest | null>;
  /** Reads the page before `beforeLine`, or the last page when null. */
  fetch: (request: ITranscriptRequest, beforeLine: number | null) => Promise<TranscriptResponseDto>;
  /** While true, follows the stream once the last page has loaded. */
  live?: MaybeRefOrGetter<boolean>;
  follow?: (
    request: ITranscriptRequest,
    afterLine: number,
    handlers: ITranscriptFollowHandlers
  ) => { close: () => void };
  /** Runs when the stream reports the run has ended, after it closes. */
  onEnd?: () => void;
}

/**
 * Reads a run's last page of transcript, then prepends each earlier page on request. While `live`, appends the run's
 * new lines from the stream after the last page, until the stream reports the run has ended.
 */
export const useTranscript = (options: ITranscriptOptions) => {
  const logService = useLogService();
  const logger = logService.createLogger('composables/useTranscript');

  const events = shallowRef<TranscriptEventDto[]>([]);

  /** Set once the last page has arrived. */
  const loaded = ref(false);

  const hasEarlier = ref(false);
  const loading = ref(false);

  /** Set when the last page read failed, so a caller loading on scroll stops until the user asks again. */
  const failed = ref(false);

  const following = ref(false);

  /** Set when the stream stopped without an end message. `follow` tries again. */
  const followFailed = ref(false);

  // Null until the last page loads, so the first read asks for the last page.
  let firstLine: number | null = null;
  let nextLine = 1;
  let follower: { close: () => void } | null = null;

  // Set by the end message, so the run's own refresh, not the stream, decides whether it is still live.
  let ended = false;

  // Bumped on every restart, so a page or message from the request before lands nowhere.
  let generation = 0;

  /** Reads the last page first, then each page before the earliest held. */
  const loadEarlier = (): Promise<void> => {
    const request = toValue(options.request);

    if (request === null || loading.value || (loaded.value && !hasEarlier.value)) {
      return Promise.resolve();
    }

    const fetchGeneration = generation;

    loading.value = true;
    failed.value = false;

    // Sets `failed` before `loading` clears, so a caller loading on scroll never sees a failed page as finished.
    return options
      .fetch(request, firstLine)
      .then(
        page => {
          if (fetchGeneration !== generation) {
            return;
          }

          events.value = [...page.events, ...events.value];
          firstLine = page.firstLine;
          hasEarlier.value = page.hasEarlier;

          if (!loaded.value) {
            nextLine = page.nextLine;
            loaded.value = true;
          }
        },
        (error: unknown) => {
          if (fetchGeneration === generation) {
            failed.value = true;
          }

          logger.error({ error }, 'loadEarlier(): Failed to fetch a transcript page');
        }
      )
      .finally(() => {
        if (fetchGeneration === generation) {
          loading.value = false;
        }
      });
  };

  const stopFollowing = () => {
    follower?.close();
    follower = null;
    following.value = false;
  };

  const onMessage = (message: TranscriptStreamMessageDto) => {
    if (message.type === 'end') {
      ended = true;

      stopFollowing();
      options.onEnd?.();

      return;
    }

    // A reconnect resumes after the last line received, but a line already held is not appended twice.
    if (message.lineNumber < nextLine) {
      return;
    }

    events.value = [...events.value, ...message.events];
    nextLine = message.lineNumber + 1;
  };

  const startFollowing = () => {
    const request = toValue(options.request);
    const canFollow = loaded.value && !followFailed.value && !ended && toValue(options.live) === true;

    if (options.follow === undefined || request === null || follower !== null || !canFollow) {
      return;
    }

    const followGeneration = generation;

    following.value = true;
    follower = options.follow(request, nextLine - 1, {
      onMessage: message => {
        if (followGeneration === generation) {
          onMessage(message);
        }
      },
      // Leaves the retry to the user, as a failed page does.
      onStop: () => {
        if (followGeneration === generation) {
          follower = null;
          following.value = false;
          followFailed.value = true;
        }
      },
    });
  };

  /** Follows again after the stream stopped, resuming after the last line held. */
  const follow = () => {
    followFailed.value = false;
  };

  const restart = () => {
    generation++;

    stopFollowing();
    ended = false;

    events.value = [];
    firstLine = null;
    nextLine = 1;
    loaded.value = false;
    hasEarlier.value = false;
    loading.value = false;
    failed.value = false;
    followFailed.value = false;

    void loadEarlier();
  };

  watch(() => toValue(options.request), restart, { deep: true });

  watch([loaded, followFailed, () => toValue(options.live)], () => {
    if (toValue(options.live) === true) {
      startFollowing();
    } else {
      stopFollowing();
    }
  });

  if (getCurrentScope() !== undefined) {
    onScopeDispose(stopFollowing);
  }

  restart();

  return { events, loaded, hasEarlier, loading, failed, following, followFailed, loadEarlier, follow };
};
