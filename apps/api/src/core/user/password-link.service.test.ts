import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { IsNull, LessThan, MoreThan } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PasswordLinkState } from '@libs/dto';

import { PasswordLink } from '@/core/user/entities/password-link.entity';
import { User } from '@/core/user/entities/user.entity';

import { ConfigService } from '@/config/config.service';
import { PasswordLinkService } from '@/core/user/password-link.service';
import { EmailService, EmailTemplate } from '@/email/email.service';

vi.mock('typeorm-transactional', () => {
  const transactionalDecorator = () => () => undefined;
  return { Transactional: transactionalDecorator };
});

const NOW = new Date('2026-11-01T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const buildUser = (overrides: Partial<User> = {}): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });

  user.id = 3;
  Object.assign(user, overrides);

  return user;
};

const buildLink = (overrides: Partial<PasswordLink> = {}): PasswordLink => {
  const passwordLink = new PasswordLink({
    tokenHash: 'hash',
    userId: 3,
    expiresAt: new Date(NOW.getTime() + HOUR_MS),
  });

  passwordLink.id = 9;
  passwordLink.user = buildUser();
  Object.assign(passwordLink, overrides);

  return passwordLink;
};

describe('PasswordLinkService', () => {
  let service: PasswordLinkService;
  let repository: {
    findOne: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let sendEmailMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

    repository = {
      findOne: vi.fn(),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
      delete: vi.fn().mockResolvedValue({ affected: 0 }),
    };
    sendEmailMock = vi.fn().mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PasswordLinkService,
        { provide: ConfigService, useValue: { webAppBaseUrl: 'https://app.test/' } },
        { provide: EmailService, useValue: { sendEmail: sendEmailMock } },
        { provide: getRepositoryToken(PasswordLink), useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(PasswordLinkService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issue', () => {
    it('stores only the hash of the token it puts in the link fragment', async () => {
      const issued = await service.issue(buildUser());

      const token = issued.link.split('#')[1];
      const stored = repository.insert.mock.calls[0][0] as PasswordLink;

      expect(issued.link).toMatch(/^https:\/\/app\.test\/set-password#[0-9a-f]{64}$/);
      expect(stored.tokenHash).toBe(sha256(token));
      expect(stored.tokenHash).not.toBe(token);
    });

    it('replaces the pending link and purges long-expired ones before inserting', async () => {
      await service.issue(buildUser());

      expect(repository.delete).toHaveBeenCalledWith({ userId: 3, usedAt: IsNull(), expiresAt: MoreThan(NOW) });
      expect(repository.delete).toHaveBeenCalledWith({
        expiresAt: LessThan(new Date(NOW.getTime() - 30 * DAY_MS)),
      });
      expect(repository.delete.mock.invocationCallOrder[1]).toBeLessThan(repository.insert.mock.invocationCallOrder[0]);
    });

    it('emails an invite lasting 7 days to a user without a password', async () => {
      const issued = await service.issue(buildUser({ passwordHash: null }));

      expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
      expect(sendEmailMock).toHaveBeenCalledWith('tester@example.com', EmailTemplate.INVITE, {
        name: 'Tester',
        link: issued.link,
        lifetime: '7 days',
      });
    });

    it('emails a reset lasting 24 hours to a user with a password', async () => {
      const issued = await service.issue(buildUser());

      expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + DAY_MS));
      expect(sendEmailMock).toHaveBeenCalledWith('tester@example.com', EmailTemplate.PASSWORD_RESET, {
        name: 'Tester',
        link: issued.link,
        lifetime: '24 hours',
      });
    });

    it('reports whether the email went', async () => {
      sendEmailMock.mockResolvedValue(false);

      const issued = await service.issue(buildUser());

      expect(issued.emailed).toBe(false);
    });
  });

  describe('check', () => {
    it('looks the link up by the hash of its token', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.check('abc');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { tokenHash: sha256('abc') },
        relations: { user: true },
      });
    });

    it('reads an unknown token as invalid', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.check('abc')).resolves.toEqual({ state: PasswordLinkState.INVALID, passwordLink: null });
    });

    it('reads a used link as used, even once expired', async () => {
      repository.findOne.mockResolvedValue(
        buildLink({ usedAt: new Date(NOW.getTime() - DAY_MS), expiresAt: new Date(NOW.getTime() - HOUR_MS) })
      );

      await expect(service.check('abc')).resolves.toEqual({ state: PasswordLinkState.USED, passwordLink: null });
    });

    it('reads a link past its expiry as expired', async () => {
      repository.findOne.mockResolvedValue(buildLink({ expiresAt: NOW }));

      await expect(service.check('abc')).resolves.toEqual({ state: PasswordLinkState.EXPIRED, passwordLink: null });
    });

    it('answers a valid link with its user', async () => {
      const passwordLink = buildLink();
      repository.findOne.mockResolvedValue(passwordLink);

      await expect(service.check('abc')).resolves.toEqual({ state: PasswordLinkState.VALID, passwordLink });
    });
  });

  describe('consume', () => {
    it('marks the link used only while it is still pending', async () => {
      await expect(service.consume(buildLink())).resolves.toBe(true);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 9, usedAt: IsNull(), expiresAt: MoreThan(NOW) },
        { usedAt: NOW }
      );
    });

    it('reports a link another request used first', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(service.consume(buildLink())).resolves.toBe(false);
    });
  });

  describe('revoke', () => {
    it('deletes the pending link of the user', async () => {
      await service.revoke(3);

      expect(repository.delete).toHaveBeenCalledWith({ userId: 3, usedAt: IsNull(), expiresAt: MoreThan(NOW) });
    });
  });
});
