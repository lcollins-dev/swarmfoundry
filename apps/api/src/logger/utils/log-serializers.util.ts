import { omit } from 'lodash';
import { IncomingMessage } from 'node:http';
import { stdSerializers } from 'pino-http';

interface ISerializedError {
  type: string;
  message: string;
  stack: string;
  code?: unknown;
}

const isSerializedError = (value: unknown): value is ISerializedError =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  'message' in value &&
  typeof value.message === 'string' &&
  'stack' in value &&
  typeof value.stack === 'string';

/**
 * Drops every property but the type, message, stack and code, since others hold secrets: a `QueryFailedError` carries
 * the query's parameters, and a validation `HttpException` the request body. pino-http hands it pino's serialized form.
 */
export function serializeError(value: unknown): unknown {
  const serialized: unknown = value instanceof Error ? stdSerializers.err(value) : value;

  if (!isSerializedError(serialized)) {
    return value;
  }

  const { type, message, stack, code } = serialized;

  return typeof code === 'string' || typeof code === 'number'
    ? { type, message, stack, code }
    : { type, message, stack };
}

/** Drops `params`, which repeats the path's segments when the web app's catch-all route took the request. */
export function serializeReceivedRequest(req: IncomingMessage): Record<string, unknown> {
  return omit(stdSerializers.req(req), 'params');
}
