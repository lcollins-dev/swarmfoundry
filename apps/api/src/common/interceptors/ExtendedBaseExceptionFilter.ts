import { Catch, ArgumentsHost, BadRequestException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

@Catch()
export class ExtendedBaseExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    let reported = exception;

    if (exception instanceof URIError) {
      reported = new BadRequestException("This link isn't valid. Check it and try again.");
    } else if (this.isExceptionWithType(exception) && exception.type === 'entity.too.large') {
      reported = new BadRequestException("That's too much to send at once. Make it shorter and try again.");
    }

    super.catch(reported, host);
  }

  isExceptionWithType(value: unknown): value is { type: string } {
    return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
  }
}
