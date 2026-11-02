import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The `Last-Event-ID` header a reconnecting event source sends. Takes a pipe, which `@Headers()` does not. */
export const lastEventId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | string[] | undefined =>
    context.switchToHttp().getRequest<Request>().headers['last-event-id']
);
