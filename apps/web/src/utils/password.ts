import { ValidationError } from '@/types/error';

export const PASSWORD_MISMATCH = "The passwords don't match.";

/** Lands on the form's field with path `confirmPassword`. */
export const passwordMismatchError = (form: string): ValidationError =>
  new ValidationError(form, { confirmPassword: { message: PASSWORD_MISMATCH } });
