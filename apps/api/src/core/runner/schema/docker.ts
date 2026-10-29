import { z } from 'zod';

export const containerWaitSchema = z.looseObject({
  StatusCode: z.number(),
});

/** Docker 29 omits an empty `Config.User` and `Config.Env`, so the typings' required fields can be absent. */
export const imageInspectSchema = z.looseObject({
  Id: z.string(),
  Config: z
    .looseObject({
      User: z.string().nullish(),
      Env: z.array(z.string()).nullish(),
    })
    .nullish(),
});

export const networkInspectSchema = z.looseObject({
  Options: z.record(z.string(), z.string()).nullish(),
});

export const pullProgressSchema = z.looseObject({
  error: z.string().optional(),
});

/** The fields dockerode adds to an error the daemon answered. */
export const dockerErrorSchema = z.looseObject({
  statusCode: z.number(),
});

export const dockerInfoSchema = z.looseObject({
  NCPU: z.number().int().positive(),
});

/** Docker reports an unpinned container's `CpusetCpus` as an empty string. */
export const containerInspectSchema = z.looseObject({
  HostConfig: z.looseObject({ CpusetCpus: z.string().nullish() }).nullish(),
});
