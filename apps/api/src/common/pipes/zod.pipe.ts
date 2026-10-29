import { ArgumentMetadata, BadRequestException, HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { kebabCase, upperFirst } from 'lodash';
import { z } from 'zod';

import { ValidationErrorDto, ValidationResponseDto } from '@libs/dto';

@Injectable()
export class ZodPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.output<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<Schema> {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    const errors = toValidationErrors(result.error.issues);
    const fieldErrors = errors.filter(error => error.path !== '');

    // A named param or query value, or a body that is not an object, has no form field to land on.
    if (metadata.data !== undefined || fieldErrors.length < errors.length) {
      throw new BadRequestException(errors[0].message);
    }

    const response: ValidationResponseDto = {
      statusCode: HttpStatus.BAD_REQUEST,
      message: fieldErrors,
      error: 'Bad Request',
    };

    throw new BadRequestException(response);
  }
}

/** Keeps the first refusal each field raised. */
export const toValidationErrors = (issues: z.core.$ZodIssue[]): ValidationErrorDto[] => {
  const errors = new Map<string, ValidationErrorDto>();

  const add = (path: PropertyKey[], message: string) => {
    const fieldPath = path.filter(segment => typeof segment === 'string');
    const key = fieldPath.join('.');

    if (!errors.has(key)) {
      errors.set(key, { path: key, name: fieldName(fieldPath.at(-1) ?? ''), message });
    }
  };

  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        add([...issue.path, key], issue.message);
      }
    } else {
      add(issue.path, issue.message);
    }
  }

  return [...errors.values()];
};

const fieldName = (property: string): string =>
  upperFirst(kebabCase(property).replace(/-/g, ' '))
    .replace(' id', '')
    .replace(/^Desc$/, 'Description');
