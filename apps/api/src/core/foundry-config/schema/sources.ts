import { z } from 'zod';

import { duration, text } from './common';

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

const gitlabSourceSchema = z.strictObject({
  type: z.literal('gitlab'),
  url: z
    .url({ protocol: /^https?$/ })
    // fetch's errors quote the whole URL, password included.
    .refine(value => {
      const url = URL.parse(value);

      return url === null || (url.username === '' && url.password === '');
    }, 'must not hold a username or password; set the token instead'),
  token: text,
  pollInterval: duration.default(DEFAULT_POLL_INTERVAL_MS),
  projects: z.array(text).min(1, 'must list at least one project'),
});

export const sourceSchema = z.discriminatedUnion('type', [gitlabSourceSchema]);
