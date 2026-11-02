import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKey } from '@/core/api-key/entities/api-key.entity';
import { User } from '@/core/user/entities/user.entity';

import { ApiKeyTokenService } from '@/core/api-key/api-key-token.service';
import { ApiKeyService } from '@/core/api-key/api-key.service';

const NOW = new Date('2026-11-01T12:00:00Z');

const buildOwner = (overrides: Partial<User> = {}): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });

  user.id = 3;
  user.userUserRoles = [];
  Object.assign(user, overrides);

  return user;
};

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let apiKeyTokenService: ApiKeyTokenService;
  let repository: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  /** Issues a real key and stores it as the row `findOne` returns. */
  const storeKey = (owner: User, lastUsedDate: Date | null = null): string => {
    const { keyId, secretHash, token } = apiKeyTokenService.issue();

    const apiKey = new ApiKey({ keyId, name: 'Laptop', secretHash, userId: owner.id });
    apiKey.id = 7;
    apiKey.lastUsedDate = lastUsedDate;
    apiKey.user = owner;
    repository.findOne.mockResolvedValue(apiKey);

    return token;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

    repository = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
      delete: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ApiKeyService, ApiKeyTokenService, { provide: getRepositoryToken(ApiKey), useValue: repository }],
    }).compile();

    service = moduleRef.get(ApiKeyService);
    apiKeyTokenService = moduleRef.get(ApiKeyTokenService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isApiKey', () => {
    it('recognises an issued key', () => {
      expect(service.isApiKey(apiKeyTokenService.issue().token)).toBe(true);
    });

    it('leaves a JWT to the session check', () => {
      expect(service.isApiKey('eyJhbGciOiJIUzI1NiJ9.e30.signature')).toBe(false);
    });
  });

  describe('issue', () => {
    it('stores a hash of the secret, never the key', async () => {
      const { apiKey, token } = await service.issue('Laptop', 3);

      const stored = repository.insert.mock.calls[0]?.[0] as ApiKey;

      expect(stored).toBe(apiKey);
      expect(stored.userId).toBe(3);
      expect(stored.name).toBe('Laptop');
      expect(token).not.toContain(stored.secretHash);
      expect(JSON.stringify(stored)).not.toContain(token);
    });
  });

  describe('revoke', () => {
    it('deletes the key', async () => {
      await service.revoke(7);

      expect(repository.delete).toHaveBeenCalledWith({ id: 7 });
    });

    it('refuses a key that does not exist', async () => {
      repository.delete.mockResolvedValue({ affected: 0 });

      await expect(service.revoke(7)).rejects.toThrow(BadRequestException);
    });
  });

  describe('verify', () => {
    it('returns the owner of a valid key', async () => {
      const owner = buildOwner();
      const token = storeKey(owner);

      await expect(service.verify(token)).resolves.toBe(owner);
    });

    it('looks the key up by its identifier with its owner and their roles', async () => {
      const token = storeKey(buildOwner());

      await service.verify(token);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { keyId: apiKeyTokenService.parse(token)?.keyId },
        relations: { user: { userUserRoles: true } },
      });
    });

    it('refuses a malformed key without a lookup', async () => {
      await expect(service.verify('sfk_short')).resolves.toBeNull();

      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('refuses an unknown key', async () => {
      await expect(service.verify(apiKeyTokenService.issue().token)).resolves.toBeNull();
    });

    it('refuses a wrong secret for a known identifier', async () => {
      const token = storeKey(buildOwner());
      const forged = `${token.slice(0, token.lastIndexOf('_') + 1)}${'A'.repeat(43)}`;

      await expect(service.verify(forged)).resolves.toBeNull();
    });

    it.each([
      ['disabled', { enabled: false }],
      ['held to first-time setup', { mustChangePassword: true }],
      ['still invited', { passwordHash: null }],
    ])('refuses a key whose owner is %s', async (_description, overrides: Partial<User>) => {
      const token = storeKey(buildOwner(overrides));

      await expect(service.verify(token)).resolves.toBeNull();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('stamps the last use of a key not used in the last minute', async () => {
      const token = storeKey(buildOwner(), new Date(NOW.getTime() - 61_000));

      await service.verify(token);

      expect(repository.update).toHaveBeenCalledWith({ id: 7 }, { lastUsedDate: NOW });
    });

    it('leaves the stamp of a key used within the last minute', async () => {
      const token = storeKey(buildOwner(), new Date(NOW.getTime() - 30_000));

      await service.verify(token);

      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('never logs a key, its secret or its hash', async () => {
      const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
      const spies = levels.map(level => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));

      const { apiKey, token } = await service.issue('Laptop', 3);
      const secret = token.slice(token.lastIndexOf('_') + 1);

      apiKey.user = buildOwner();
      repository.findOne.mockResolvedValue(apiKey);

      await service.verify(token);
      await service.verify(`${token.slice(0, token.lastIndexOf('_') + 1)}${'A'.repeat(43)}`);
      await service.revoke(apiKey.id);

      const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));

      expect(spies.some(spy => spy.mock.calls.length > 0)).toBe(true);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(apiKey.secretHash);

      spies.forEach(spy => spy.mockRestore());
    });
  });
});
