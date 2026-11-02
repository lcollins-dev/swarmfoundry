import { describe, expect, it } from 'vitest';

import { PASSWORD_MISMATCH, passwordMismatchError } from './password';

describe('passwordMismatchError', () => {
  it('refuses the confirm password field of the given form', () => {
    const error = passwordMismatchError('profile');

    expect(error.form).toBe('profile');
    expect(error.fields).toEqual({ confirmPassword: { message: PASSWORD_MISMATCH } });
  });
});
