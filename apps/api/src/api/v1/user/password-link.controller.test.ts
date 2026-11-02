import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PasswordLinkState } from '@libs/dto';

import { PasswordLink } from '@/core/user/entities/password-link.entity';
import { User } from '@/core/user/entities/user.entity';

import { PasswordLinkService } from '@/core/user/password-link.service';
import { UserService } from '@/core/user/user.service';

import { PasswordLinkController } from '@/api/v1/user/password-link.controller';

const TOKEN = 'a'.repeat(64);
const EXPIRES_AT = new Date('2026-11-02T12:00:00Z');

const buildLink = (passwordHash: string | null): PasswordLink => {
  const passwordLink = new PasswordLink({ tokenHash: 'hash', userId: 3, expiresAt: EXPIRES_AT });

  passwordLink.user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash });

  return passwordLink;
};

describe('PasswordLinkController', () => {
  let controller: PasswordLinkController;
  let checkMock: ReturnType<typeof vi.fn>;
  let setPasswordWithLinkMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    checkMock = vi.fn();
    setPasswordWithLinkMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [PasswordLinkController],
      providers: [
        { provide: PasswordLinkService, useValue: { check: checkMock } },
        { provide: UserService, useValue: { setPasswordWithLink: setPasswordWithLinkMock } },
      ],
    }).compile();

    controller = moduleRef.get(PasswordLinkController);
  });

  describe('checkPasswordLink', () => {
    it('answers a link that no longer works with its state alone', async () => {
      checkMock.mockResolvedValue({ state: PasswordLinkState.EXPIRED, passwordLink: null });

      await expect(controller.checkPasswordLink({ token: TOKEN })).resolves.toEqual({
        state: PasswordLinkState.EXPIRED,
        passwordLink: null,
      });
    });

    it('answers an invite for a user without a password', async () => {
      checkMock.mockResolvedValue({ state: PasswordLinkState.VALID, passwordLink: buildLink(null) });

      await expect(controller.checkPasswordLink({ token: TOKEN })).resolves.toEqual({
        state: PasswordLinkState.VALID,
        passwordLink: { name: 'Tester', email: 'tester@example.com', invite: true, expiresAt: EXPIRES_AT },
      });
    });

    it('answers a reset for a user with a password', async () => {
      checkMock.mockResolvedValue({ state: PasswordLinkState.VALID, passwordLink: buildLink('hash') });

      const response = await controller.checkPasswordLink({ token: TOKEN });

      expect(response.passwordLink?.invite).toBe(false);
    });
  });

  describe('setPassword', () => {
    it('answers the session token for the user', async () => {
      setPasswordWithLinkMock.mockResolvedValue('session-token');

      await expect(controller.setPassword({ token: TOKEN, password: 'New$Pass1' })).resolves.toEqual({
        token: 'session-token',
      });

      expect(setPasswordWithLinkMock).toHaveBeenCalledWith(TOKEN, 'New$Pass1');
    });
  });
});
