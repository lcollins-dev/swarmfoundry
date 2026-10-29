import { describe, expect, it } from 'vitest';

import { signInReturnPath } from './signInReturnPath';

describe('signInReturnPath', () => {
  it('returns a path on this origin, with its query and hash', () => {
    expect(signInReturnPath({ redirect: '/edit-profile' })).toBe('/edit-profile');
    expect(signInReturnPath({ redirect: '/admin/users?page=2#top' })).toBe('/admin/users?page=2#top');
  });

  it('returns nothing when there is no single return path', () => {
    expect(signInReturnPath({})).toBeUndefined();
    expect(signInReturnPath({ redirect: null })).toBeUndefined();
    expect(signInReturnPath({ redirect: ['/edit-profile', '/admin'] })).toBeUndefined();
    expect(signInReturnPath({ redirect: '' })).toBeUndefined();
  });

  it('refuses anything that leaves this origin', () => {
    expect(signInReturnPath({ redirect: 'https://evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '//evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/\\evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/\t/evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/.//evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/..//evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/%2e//evil.example/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: 'javascript:alert(1)' })).toBeUndefined();
    expect(signInReturnPath({ redirect: 'admin' })).toBeUndefined();
  });

  it('refuses the sign in and register pages themselves', () => {
    expect(signInReturnPath({ redirect: '/sign-in' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/sign-in/?redirect=/admin' })).toBeUndefined();
    expect(signInReturnPath({ redirect: '/Register' })).toBeUndefined();
  });
});
