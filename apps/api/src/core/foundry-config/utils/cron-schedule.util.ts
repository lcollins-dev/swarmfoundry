import { CronExpressionParser } from 'cron-parser';

// No seconds field, so no trigger fires faster than the scheduler ticks.
const FIELD_COUNT = 5;

// cron-parser draws a new random value for an `H` on every parse, so its fire times would never repeat. Only the
// weekday name THU holds an `H` otherwise.
const HASHED_TOKEN = /H/;
const THURSDAY = /THU/gi;

// Every fire time is in UTC, whatever the host's zone.
const parse = (expression: string, currentDate: Date) =>
  CronExpressionParser.parse(expression, { currentDate, tz: 'UTC' });

export function isCronExpression(expression: string): boolean {
  if (expression.trim().split(/\s+/).length !== FIELD_COUNT || HASHED_TOKEN.test(expression.replace(THURSDAY, ''))) {
    return false;
  }

  try {
    parse(expression, new Date()).next();

    return true;
  } catch {
    return false;
  }
}

export function fireTimeAtOrBefore(expression: string, date: Date): Date {
  return fireTimeBefore(expression, new Date(date.getTime() + 1));
}

export function fireTimeBefore(expression: string, date: Date): Date {
  return parse(expression, date).prev().toDate();
}

export function fireTimeAfter(expression: string, date: Date): Date {
  return parse(expression, date).next().toDate();
}
