import { describe, expect, it } from 'vitest';

import { UserListStatus, UserListRequestDto } from './admin';

describe('UserListRequestDto', () => {
  it('keeps a search term', () => {
    expect(UserListRequestDto.parse({ search: 'tester', status: UserListStatus.ALL }).search).toBe('tester');
  });

  it('reads an empty search as no search', () => {
    expect(UserListRequestDto.parse({ search: '', status: UserListStatus.ALL }).search).toBeUndefined();
  });

  it('leaves an absent search absent', () => {
    expect(UserListRequestDto.parse({ status: UserListStatus.ALL })).toEqual({ status: UserListStatus.ALL });
  });
});
