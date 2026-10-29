import moment from 'moment';

/** `Today`, `Yesterday` or a date such as `2 Mar 2026`, in the browser's time zone. */
export const formatDay = (date: Date, now: Date = new Date()): string => {
  const day = moment(date).startOf('day');
  const today = moment(now).startOf('day');

  if (day.isSame(today)) {
    return 'Today';
  }

  if (day.isSame(today.clone().subtract(1, 'day'))) {
    return 'Yesterday';
  }

  return moment(date).format('D MMM YYYY');
};

export const formatDate = (date: Date): string => {
  return moment(date).format('DD/MM/YY');
};

export const formatDayTime = (date: Date): string => moment(date).format('D MMM YYYY, HH:mm');

export const formatRelativeDate = (date: Date): string => {
  return moment(date).fromNow();
};

/** A span of time such as `0.4 s`, `12 s`, `3 min 5 s` or `1 h 4 min`; a negative span reads as `0.0 s`. */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 9950) {
    return `${(Math.max(milliseconds, 0) / 1000).toFixed(1)} s`;
  }

  const seconds = Math.round(milliseconds / 1000);

  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min ${seconds % 60} s`;
  }

  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** Reads the local calendar day, not the UTC one. */
export const toIsoDate = (date: Date): string => {
  return moment(date).format('YYYY-MM-DD');
};
