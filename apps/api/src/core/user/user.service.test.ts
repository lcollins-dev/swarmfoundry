import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRoleId } from '@libs/dto';

import { UserRole } from '@/core/user/entities/user-role.entity';
import { UserUserRole } from '@/core/user/entities/user-user-role.entity';
import { User } from '@/core/user/entities/user.entity';

import { ConfigService } from '@/config/config.service';
import { TokenService } from '@/core/user/token.service';
import { ACCOUNT_DISABLED_MESSAGE, SESSION_EXPIRED_MESSAGE, UserService } from '@/core/user/user.service';
import { EmailService, EmailTemplate } from '@/email/email.service';

vi.mock('bcryptjs', () => ({
  hash: vi.fn(),
  compare: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(),
}));

vi.mock('typeorm-transactional', () => {
  const transactionalDecorator = () => () => undefined;
  return { Transactional: transactionalDecorator };
});

type BcryptHash = (password: string, rounds: number) => Promise<string>;
type BcryptCompare = (password: string, hash: string) => Promise<boolean>;
type UuidV4 = () => string;

interface IRepositoryMock {
  findOne: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  createQueryBuilder: ReturnType<typeof vi.fn>;
}

interface IQueryBuilderMock {
  leftJoinAndSelect: ReturnType<typeof vi.fn>;
  andWhere: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  take: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
  getManyAndCount: ReturnType<typeof vi.fn>;
}

const makeQueryBuilderMock = (): IQueryBuilderMock => {
  const queryBuilder: Partial<IQueryBuilderMock> = {};

  queryBuilder.leftJoinAndSelect = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.andWhere = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.take = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.skip = vi.fn().mockReturnValue(queryBuilder);
  queryBuilder.getManyAndCount = vi.fn().mockResolvedValue([[], 0]);

  return queryBuilder as IQueryBuilderMock;
};

const makeRepoMock = (): IRepositoryMock => ({
  findOne: vi.fn(),
  find: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  createQueryBuilder: vi.fn(),
});

const buildUser = (overrides: Partial<User> = {}): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hashed-password' });

  user.id = 1;
  user.enabled = true;
  user.sessionUuid = 'session-uuid';
  user.lastLoginSuccess = null;
  user.lastLoginFail = null;
  user.lastAccess = new Date();
  user.createdDate = new Date();
  user.userUserRoles = [];

  Object.assign(user, overrides);

  return user;
};

describe('UserService', () => {
  let userService: UserService;
  let userRepository: IRepositoryMock;
  let userRoleRepository: IRepositoryMock;
  let userUserRoleRepository: IRepositoryMock;
  let createTokenMock: ReturnType<typeof vi.fn>;
  let decodeTokenMock: ReturnType<typeof vi.fn>;
  let sendEmailMock: ReturnType<typeof vi.fn>;
  let configMock: { userPasswordHashRounds: number; userIdleTimeout: string; webAppBaseUrl: string };

  beforeEach(async () => {
    userRepository = makeRepoMock();
    userRoleRepository = makeRepoMock();
    userUserRoleRepository = makeRepoMock();
    createTokenMock = vi.fn();
    decodeTokenMock = vi.fn();
    sendEmailMock = vi.fn().mockResolvedValue(true);

    configMock = {
      userPasswordHashRounds: 4,
      userIdleTimeout: '15m',
      webAppBaseUrl: 'https://app.test',
    };

    vi.mocked(bcrypt.hash as BcryptHash).mockImplementation(password => Promise.resolve(`hashed:${password}`));
    vi.mocked(bcrypt.compare as BcryptCompare).mockImplementation((password, hash) =>
      Promise.resolve(hash === `hashed:${password}`)
    );
    vi.mocked(uuidv4 as UuidV4).mockReturnValue('fixed-session-uuid');

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: ConfigService, useValue: configMock },
        { provide: EmailService, useValue: { sendEmail: sendEmailMock } },
        { provide: TokenService, useValue: { createToken: createTokenMock, decodeToken: decodeTokenMock } },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepository },
        { provide: getRepositoryToken(UserUserRole), useValue: userUserRoleRepository },
      ],
    }).compile();

    userService = moduleRef.get(UserService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createUser', () => {
    it('normalizes the email before checking for duplicates', async () => {
      userRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(buildUser());
      userRepository.insert.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([]);
      userUserRoleRepository.delete.mockResolvedValue(undefined);

      await userService.createUser('Tester', '  TESTER@Example.com  ', 'pw', []);

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { email: 'tester@example.com' } });
    });

    it('rejects when a user with the same email already exists', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());

      await expect(userService.createUser('Tester', 'tester@example.com', 'pw', [])).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.insert).not.toHaveBeenCalled();
    });

    it('hashes the password using the configured rounds and stores the user', async () => {
      userRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(buildUser());
      userRepository.insert.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([]);
      userUserRoleRepository.delete.mockResolvedValue(undefined);

      await userService.createUser('Tester', 'tester@example.com', 'plain-password', []);

      expect(bcrypt.hash).toHaveBeenCalledWith('plain-password', 4);
      expect(userRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'tester@example.com', passwordHash: 'hashed:plain-password' })
      );
    });

    it('sends a welcome email when the flag is set', async () => {
      userRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(buildUser());
      userRepository.insert.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([]);
      userUserRoleRepository.delete.mockResolvedValue(undefined);

      await userService.createUser('Tester', 'tester@example.com', 'pw', [], true);

      expect(sendEmailMock).toHaveBeenCalledWith('tester@example.com', EmailTemplate.WELCOME, {
        name: 'Tester',
        signInUrl: 'https://app.test/sign-in',
      });
    });

    it('does not send a welcome email by default', async () => {
      userRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(buildUser());
      userRepository.insert.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([]);
      userUserRoleRepository.delete.mockResolvedValue(undefined);

      await userService.createUser('Tester', 'tester@example.com', 'pw', []);

      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe('checkLoginWithThrow', () => {
    it('normalizes the email when looking up the user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.checkLoginWithThrow('  TESTER@Example.com  ', 'pw')).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { email: 'tester@example.com' } });
    });

    it('throws when no user matches the email', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.checkLoginWithThrow('tester@example.com', 'pw')).rejects.toThrow(BadRequestException);
    });

    it('records a failed login and throws when the password is wrong', async () => {
      const user = buildUser({ passwordHash: 'hashed:correct-password' });
      userRepository.findOne.mockResolvedValue(user);

      await expect(userService.checkLoginWithThrow('tester@example.com', 'wrong-password')).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ lastLoginFail: expect.any(Date) as Date }) as Partial<User>
      );
    });

    it('returns the user when the password is correct', async () => {
      const user = buildUser({ passwordHash: 'hashed:correct-password' });
      userRepository.findOne.mockResolvedValue(user);

      const result = await userService.checkLoginWithThrow('tester@example.com', 'correct-password');

      expect(result).toBe(user);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('refuses a disabled account holding the right password', async () => {
      const user = buildUser({ passwordHash: 'hashed:correct-password', enabled: false });
      userRepository.findOne.mockResolvedValue(user);

      await expect(userService.checkLoginWithThrow('tester@example.com', 'correct-password')).rejects.toThrow(
        new BadRequestException(ACCOUNT_DISABLED_MESSAGE)
      );
    });

    it('reports a wrong password on a disabled account as a bad login', async () => {
      const user = buildUser({ passwordHash: 'hashed:correct-password', enabled: false });
      userRepository.findOne.mockResolvedValue(user);

      await expect(userService.checkLoginWithThrow('tester@example.com', 'wrong-password')).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ lastLoginFail: expect.any(Date) as Date }) as Partial<User>
      );
    });
  });

  describe('updateProfile', () => {
    it('drops the session when the password changes', async () => {
      const user = buildUser();
      userRepository.findOne.mockResolvedValue(user);

      await userService.updateProfile('Tester', 'tester@example.com', 'new-password', 1);

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ sessionUuid: null, passwordHash: 'hashed:new-password' })
      );
    });

    it('releases the account from first-time setup when the password changes', async () => {
      userRepository.findOne.mockResolvedValue(buildUser({ mustChangePassword: true }));

      await userService.updateProfile('Tester', 'tester@example.com', 'new-password', 1);

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ mustChangePassword: false })
      );
    });

    it('refuses the password the account was set up with while first-time setup is pending', async () => {
      userRepository.findOne.mockResolvedValue(
        buildUser({ mustChangePassword: true, passwordHash: 'hashed:default-password' })
      );

      await expect(userService.updateProfile('Tester', 'tester@example.com', 'default-password', 1)).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('keeps the session, and any hold on first-time setup, when the password is left alone', async () => {
      const user = buildUser();
      userRepository.findOne.mockResolvedValue(user);

      await userService.updateProfile('Renamed', 'tester@example.com', undefined, 1);

      expect(userRepository.update).toHaveBeenCalledWith({ id: 1 }, { name: 'Renamed', email: 'tester@example.com' });
    });

    it('rejects an email already held by another user', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(buildUser({ id: 2, email: 'taken@example.com' }));

      await expect(userService.updateProfile('Tester', 'taken@example.com', undefined, 1)).rejects.toThrow(
        BadRequestException
      );

      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('startSession', () => {
    // The exact payload matters: unlike a login, starting a session leaves the timestamps alone.
    it('stores a new session uuid, signs it, and writes nothing else', async () => {
      userRepository.update.mockResolvedValue(undefined);
      createTokenMock.mockResolvedValue('signed-jwt');

      const token = await userService.startSession(buildUser());

      expect(userRepository.update).toHaveBeenCalledWith({ id: 1 }, { sessionUuid: 'fixed-session-uuid' });
      expect(token).toBe('signed-jwt');
    });
  });

  describe('createLoginToken', () => {
    it('stores a new session uuid and asks the token service to sign it', async () => {
      const user = buildUser();
      userRepository.update.mockResolvedValue(undefined);
      createTokenMock.mockResolvedValue('signed-jwt');

      const token = await userService.createLoginToken(user);

      expect(vi.mocked(uuidv4 as UuidV4)).toHaveBeenCalled();
      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({
          sessionUuid: 'fixed-session-uuid',
          lastLoginSuccess: expect.any(Date) as Date,
        }) as Partial<User>
      );
      expect(createTokenMock).toHaveBeenCalledWith('fixed-session-uuid');
      expect(token).toBe('signed-jwt');
    });
  });

  describe('checkToken', () => {
    it('throws when the token cannot be decoded', async () => {
      decodeTokenMock.mockResolvedValue(null);

      await expect(userService.checkToken('bad-token')).rejects.toThrow(
        new UnauthorizedException(SESSION_EXPIRED_MESSAGE)
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('throws when no user matches the decoded session uuid', async () => {
      decodeTokenMock.mockResolvedValue({ sub: 'unknown-session' });
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.checkToken('any-token')).rejects.toThrow(
        new UnauthorizedException(SESSION_EXPIRED_MESSAGE)
      );
    });

    it('throws when the matched user is disabled', async () => {
      decodeTokenMock.mockResolvedValue({ sub: 'session-uuid' });
      userRepository.findOne.mockResolvedValue(buildUser({ enabled: false }));

      await expect(userService.checkToken('any-token')).rejects.toThrow(
        new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE)
      );
    });

    it('throws session-expired when the user has been idle for longer than the configured timeout', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-05-15T12:00:00Z');
      vi.setSystemTime(now);

      const lastAccess = new Date(now.getTime() - 16 * 60 * 1000);
      decodeTokenMock.mockResolvedValue({ sub: 'session-uuid' });
      userRepository.findOne.mockResolvedValue(buildUser({ lastAccess }));

      await expect(userService.checkToken('any-token')).rejects.toThrow(
        new UnauthorizedException(SESSION_EXPIRED_MESSAGE)
      );
    });

    it('returns the user and refreshes lastAccess on success', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-05-15T12:00:00Z');
      vi.setSystemTime(now);

      const lastAccess = new Date(now.getTime() - 5 * 60 * 1000);
      const user = buildUser({ lastAccess });
      decodeTokenMock.mockResolvedValue({ sub: 'session-uuid' });
      userRepository.findOne.mockResolvedValue(user);

      const result = await userService.checkToken('any-token');

      expect(result).toBe(user);
      expect(userRepository.update).toHaveBeenCalledWith({ id: 1 }, {});
    });

    it('fetches the user with the userUserRoles relation', async () => {
      decodeTokenMock.mockResolvedValue({ sub: 'session-uuid' });
      userRepository.findOne.mockResolvedValue(buildUser());

      await userService.checkToken('any-token');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { sessionUuid: 'session-uuid' },
        relations: { userUserRoles: true },
      });
    });
  });

  describe('updateRoles', () => {
    it('throws when the user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.updateRoles([UserRoleId.USER_ADMIN], 1)).rejects.toThrow(BadRequestException);
    });

    it('throws when one or more role ids are not recognised', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());
      userUserRoleRepository.delete.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([new UserRole(UserRoleId.USER_ADMIN, 'User Admin')]);

      await expect(userService.updateRoles([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN], 1)).rejects.toThrow(
        BadRequestException
      );

      expect(userUserRoleRepository.insert).not.toHaveBeenCalled();
    });

    it('clears existing roles before inserting the new set', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());
      userUserRoleRepository.delete.mockResolvedValue(undefined);
      userRoleRepository.find.mockResolvedValue([
        new UserRole(UserRoleId.USER_ADMIN, 'User Admin'),
        new UserRole(UserRoleId.SYSTEM_ADMIN, 'System Admin'),
      ]);
      userUserRoleRepository.insert.mockResolvedValue(undefined);

      await userService.updateRoles([UserRoleId.USER_ADMIN, UserRoleId.SYSTEM_ADMIN], 1);

      expect(userUserRoleRepository.delete).toHaveBeenCalledWith({ userId: 1 });
      expect(userUserRoleRepository.insert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ userId: 1, userRoleId: UserRoleId.USER_ADMIN })
      );
      expect(userUserRoleRepository.insert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ userId: 1, userRoleId: UserRoleId.SYSTEM_ADMIN })
      );
    });
  });

  describe('findRoles', () => {
    it('returns every role', async () => {
      const roles = [new UserRole(UserRoleId.USER_ADMIN, 'User Admin')];
      userRoleRepository.find.mockResolvedValue(roles);

      await expect(userService.findRoles()).resolves.toBe(roles);
    });
  });

  describe('findAndCount', () => {
    let queryBuilder: IQueryBuilderMock;

    beforeEach(() => {
      queryBuilder = makeQueryBuilderMock();
      userRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    });

    it('skips the search clause when no search term is given', async () => {
      await userService.findAndCount({}, 0, 10);

      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('wraps the search term in wildcards and matches name or email', async () => {
      await userService.findAndCount({ search: 'tester' }, 0, 10);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(expect.stringContaining('LOWER(user.email)'), {
        search: '%tester%',
      });
    });

    it('filters on enabled when asked for enabled users', async () => {
      await userService.findAndCount({ enabled: true }, 0, 10);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('user.enabled = :enabled', { enabled: true });
    });

    it('filters on disabled when asked for disabled users', async () => {
      await userService.findAndCount({ enabled: false }, 0, 10);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('user.enabled = :enabled', { enabled: false });
    });

    it('applies the offset and limit it is given', async () => {
      await userService.findAndCount({}, 20, 10);

      expect(queryBuilder.take).toHaveBeenCalledWith(10);
      expect(queryBuilder.skip).toHaveBeenCalledWith(20);
    });

    it('returns the page of rows and the total', async () => {
      const user = buildUser();
      queryBuilder.getManyAndCount.mockResolvedValue([[user], 21]);

      await expect(userService.findAndCount({}, 0, 10)).resolves.toEqual([[user], 21]);
    });
  });

  describe('countByState', () => {
    it('counts every user and the enabled ones', async () => {
      userRepository.count.mockResolvedValueOnce(10).mockResolvedValueOnce(7);

      await expect(userService.countByState()).resolves.toEqual({ total: 10, enabled: 7 });

      expect(userRepository.count).toHaveBeenLastCalledWith({ where: { enabled: true } });
    });
  });

  describe('findWithThrow', () => {
    it('throws when the user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.findWithThrow(1)).rejects.toThrow(BadRequestException);
    });

    it('loads the role junction rows when asked for them', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());

      await userService.findWithThrow(1, true);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: { userUserRoles: true },
      });
    });

    it('leaves the roles out by default', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());

      await userService.findWithThrow(1);

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 }, relations: {} });
    });
  });

  describe('setEnabled', () => {
    it('throws when the user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(userService.setEnabled(1, false)).rejects.toThrow(BadRequestException);

      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('stores the new enabled flag', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());
      userRepository.update.mockResolvedValue(undefined);

      await userService.setEnabled(1, false);

      expect(userRepository.update).toHaveBeenCalledWith({ id: 1 }, { enabled: false });
    });
  });

  describe('invalidateSessions', () => {
    it('clears the session uuid for the user', async () => {
      userRepository.update.mockResolvedValue(undefined);

      await userService.invalidateSessions(42);

      expect(userRepository.update).toHaveBeenCalledWith({ id: 42 }, { sessionUuid: null });
    });
  });
});
