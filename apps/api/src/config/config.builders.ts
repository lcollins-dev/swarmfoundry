import { validateCronExpression } from 'cron';
import { type StringValue } from 'ms';
import { z } from 'zod';

export function blankAsAbsent<TSchema extends z.ZodType>(schema: TSchema) {
  return z.preprocess(value => (typeof value === 'string' && value.trim().length === 0 ? undefined : value), schema);
}

export function integer(fallback: number, min?: number) {
  const schema = z.coerce.number().int();

  return blankAsAbsent((min === undefined ? schema : schema.min(min)).default(fallback));
}

/** A setting whose blank value falls back rather than reaching the app as an empty string. */
export function text(fallback: string) {
  return blankAsAbsent(z.string().default(fallback));
}

const DURATION_PATTERN = /^(0|\d+(\.\d+)?\s*(ms|s|m|h|d|w|y|seconds?|minutes?|hours?|days?|weeks?|years?|msecs?))$/i;

/** A span with a unit, e.g. `24h`, or `0`; `ms` reads a bare number as milliseconds. */
export function duration(fallback: StringValue) {
  return blankAsAbsent(
    z
      .custom<StringValue>(value => typeof value === 'string' && DURATION_PATTERN.test(value), {
        message: 'must be a duration with a unit, such as 24h, 30m or 1500ms, or 0',
      })
      .default(fallback)
  );
}

export function cron(fallback: string) {
  return blankAsAbsent(
    z
      .string()
      .refine(value => validateCronExpression(value).valid, { message: 'must be a cron expression such as 17 * * * *' })
      .default(fallback)
  );
}

/** Case-insensitive, so `TRUE` and `True` read the same as `true`. */
export function flag(fallback: boolean) {
  return blankAsAbsent(
    z.preprocess(
      value => (typeof value === 'string' ? value.toLowerCase() : value),
      z
        .enum(['true', 'false'])
        .default(fallback ? 'true' : 'false')
        .transform(value => value === 'true')
    )
  );
}
