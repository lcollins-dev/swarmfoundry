import { z } from 'zod';

/** GitLab answers `commit_email` with the primary email unless the user chose another. */
export const gitlabUserSchema = z.looseObject({
  name: z.string().trim().min(1),
  commit_email: z.string().trim().min(1),
});
