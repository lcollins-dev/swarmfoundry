import { timingSafeEqual } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyTokenService } from './api-key-token.service';

vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal<typeof import('node:crypto')>();

  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

describe('ApiKeyTokenService', () => {
  let apiKeyTokenService: ApiKeyTokenService;

  beforeEach(() => {
    apiKeyTokenService = new ApiKeyTokenService();
  });

  describe('issue', () => {
    it('carries the identifier and a recognisable prefix in the token', () => {
      const issued = apiKeyTokenService.issue();

      expect(issued.token.startsWith('sfk_')).toBe(true);
      expect(issued.token).toContain(issued.keyId);
    });

    it('stores a hash the token cannot be recovered from', () => {
      const issued = apiKeyTokenService.issue();

      expect(issued.secretHash).toHaveLength(64);
      expect(issued.token).not.toContain(issued.secretHash);
    });

    it('issues a distinct identifier and secret each time', () => {
      const first = apiKeyTokenService.issue();
      const second = apiKeyTokenService.issue();

      expect(first.keyId).not.toBe(second.keyId);
      expect(first.secretHash).not.toBe(second.secretHash);
    });
  });

  describe('parse', () => {
    it('splits an issued token back into its identifier and secret', () => {
      const issued = apiKeyTokenService.issue();
      const parsed = apiKeyTokenService.parse(issued.token);

      expect(parsed?.keyId).toBe(issued.keyId);
      expect(apiKeyTokenService.matches(parsed?.secret ?? '', issued.secretHash)).toBe(true);
    });

    it('reads a secret containing the separator', () => {
      const parsed = apiKeyTokenService.parse(`sfk_${'a'.repeat(24)}_abc_def`);

      expect(parsed?.keyId).toBe('a'.repeat(24));
      expect(parsed?.secret).toBe('abc_def');
    });

    it.each([
      ['an empty string', ''],
      ['a token with no prefix', `${'a'.repeat(24)}_secret`],
      ['a foreign prefix', `sk_${'a'.repeat(24)}_secret`],
      ['a short identifier', 'sfk_abc_secret'],
      ['a non-hex identifier', `sfk_${'z'.repeat(24)}_secret`],
      ['no secret', `sfk_${'a'.repeat(24)}_`],
      ['no separator', `sfk_${'a'.repeat(24)}secret`],
    ])('refuses %s', (_description, token) => {
      expect(apiKeyTokenService.parse(token)).toBeNull();
    });
  });

  describe('matches', () => {
    it('compares the hashes in constant time', () => {
      const issued = apiKeyTokenService.issue();
      vi.mocked(timingSafeEqual).mockClear();

      apiKeyTokenService.matches(apiKeyTokenService.parse(issued.token)?.secret ?? '', issued.secretHash);

      expect(timingSafeEqual).toHaveBeenCalledOnce();
    });

    it("refuses another key's secret", () => {
      const issued = apiKeyTokenService.issue();
      const other = apiKeyTokenService.issue();

      expect(apiKeyTokenService.matches(apiKeyTokenService.parse(other.token)?.secret ?? '', issued.secretHash)).toBe(
        false
      );
    });

    it('refuses a hash of the wrong width rather than throwing', () => {
      expect(apiKeyTokenService.matches('secret', 'abcd')).toBe(false);
    });
  });
});
