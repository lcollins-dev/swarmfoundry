import ms, { type StringValue } from 'ms';
import { posix } from 'node:path';
import { z } from 'zod';

// Later stages name containers, networks and run keys after these.
export const name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, "must start with a letter or digit and hold only letters, digits, '.', '_' or '-'");

export const text = z.string().min(1, 'must not be empty');

export const label = text;

export const username = z
  .string()
  .regex(
    /^[a-z0-9_.][a-z0-9_.-]*$/i,
    "must be a username without the '@', holding only letters, digits, '.', '_' or '-'"
  );

const DURATION_PATTERN = /^\d+(\.\d+)?(ms|s|m|h|d)$/;

export const duration = z
  .custom<StringValue>(value => typeof value === 'string' && DURATION_PATTERN.test(value), {
    message: 'must be a duration with a unit, such as 90s, 30m or 2h',
  })
  .transform(value => ms(value))
  .refine(milliseconds => milliseconds > 0, 'must be longer than 0');

const MEMORY_PATTERN = /^(\d+)([bkmg]?)$/i;

const MEMORY_UNITS = new Map([
  ['', 1],
  ['b', 1],
  ['k', 1024],
  ['m', 1024 ** 2],
  ['g', 1024 ** 3],
]);

export const memoryBytes = z.string().transform((value, context) => {
  const match = MEMORY_PATTERN.exec(value);
  const unit = MEMORY_UNITS.get(match?.[2]?.toLowerCase() ?? 'none');

  if (match === null || unit === undefined) {
    context.addIssue({ code: 'custom', message: 'must be a size such as 512m or 8g' });

    return z.NEVER;
  }

  return Number(match[1]) * unit;
});

export const absolutePath = z.string().refine(value => posix.isAbsolute(value), 'must be an absolute path');

const variableName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must start with a letter and hold only letters, digits or "_"');

export const variables = z.record(variableName, z.union([z.string(), z.number(), z.boolean()]).transform(String));
