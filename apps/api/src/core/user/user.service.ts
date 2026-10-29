import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import ms from 'ms';
import { In, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { v4 as uuidv4 } from 'uuid';

import { UserRoleId } from '@libs/dto';

import { UserRole } from './entities/user-role.entity';
import { UserUserRole } from './entities/user-user-role.entity';
import { User } from './entities/user.entity';

import { TokenService } from './token.service';
import { ConfigService } from '@/config/config.service';
import { EmailService, EmailTemplate } from '@/email/email.service';

const INVALID_LOGIN_MESSAGE = "That email and password don't match. Check them and try again.";
const USER_MISSING_MESSAGE = "This user doesn't exist.";
const EMAIL_TAKEN_MESSAGE = 'That email address is already in use. Use a different one.';
export const SESSION_EXPIRED_MESSAGE = 'Your session has ended. Sign in again to continue.';
export const NOT_ALLOWED_MESSAGE = "You don't have access to that.";
export const ACCOUNT_DISABLED_MESSAGE = 'This account has been disabled.';

export interface IUserCriteria {
  search?: string;
  enabled?: boolean;
}

export interface IUserCounts {
  total: number;
  enabled: number;
}

@Injectable()
export class UserService {
  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly tokenService: TokenService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
    @InjectRepository(UserUserRole)
    private readonly userUserRoleRepository: Repository<UserUserRole>
  ) {}

  async createUser(
    name: string,
    email: string,
    password: string,
    userRoleIds: UserRoleId[],
    sendWelcomeEmail = false
  ): Promise<User> {
    // Clean up email
    email = email.trim().toLowerCase();

    const emailUser = await this.userRepository.findOne({ where: { email } });

    if (emailUser) {
      throw new BadRequestException(EMAIL_TAKEN_MESSAGE);
    }

    const passwordHash = await bcrypt.hash(password, this.configService.userPasswordHashRounds);

    const user = new User({ name, email, passwordHash });
    await this.userRepository.insert(user);

    await this.updateRoles(userRoleIds, user.id);

    if (sendWelcomeEmail) {
      await this.emailService.sendEmail(email, EmailTemplate.WELCOME, {
        name,
        signInUrl: `${this.configService.webAppBaseUrl}/sign-in`,
      });
    }

    return user;
  }

  findRoles(): Promise<UserRole[]> {
    return this.userRoleRepository.find();
  }

  /** Ordered by name, each user carrying its roles. */
  findAndCount(criteria: IUserCriteria, skip: number, take: number): Promise<[User[], number]> {
    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.userUserRoles', 'userUserRole');

    if (criteria.search !== undefined) {
      queryBuilder.andWhere('(LOWER(user.name) LIKE LOWER(:search) OR LOWER(user.email) LIKE LOWER(:search))', {
        search: `%${criteria.search}%`,
      });
    }

    if (criteria.enabled !== undefined) {
      queryBuilder.andWhere('user.enabled = :enabled', { enabled: criteria.enabled });
    }

    return queryBuilder.orderBy('user.name', 'ASC').take(take).skip(skip).getManyAndCount();
  }

  async countByState(): Promise<IUserCounts> {
    const total = await this.userRepository.count();
    const enabled = await this.userRepository.count({ where: { enabled: true } });

    return { total, enabled };
  }

  async findWithThrow(userId: number, withRoles = false): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: withRoles ? { userUserRoles: true } : {},
    });

    if (!user) {
      throw new BadRequestException(USER_MISSING_MESSAGE);
    }

    return user;
  }

  async setEnabled(userId: number, enabled: boolean): Promise<void> {
    const user = await this.findWithThrow(userId);

    await this.userRepository.update({ id: user.id }, { enabled });
  }

  /**
   * Check users credentials throwing if they are invalid
   * @param email
   * @param password
   * @returns
   */
  @Transactional()
  async checkLoginWithThrow(email: string, password: string): Promise<User> {
    // Clean up email
    email = email.trim().toLowerCase();

    const user = await this.userRepository.findOne({ where: { email } });

    if (!user) {
      throw new BadRequestException(INVALID_LOGIN_MESSAGE);
    }

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      await this.userRepository.update({ id: user.id }, { lastLoginFail: new Date() });
      throw new BadRequestException(INVALID_LOGIN_MESSAGE);
    }

    if (!user.enabled) {
      throw new BadRequestException(ACCOUNT_DISABLED_MESSAGE);
    }

    return user;
  }

  /**
   * Create token for a user as part of the login flow
   * @param user
   * @returns
   */
  async createLoginToken(user: User): Promise<string> {
    const sessionUuid = uuidv4();

    await this.userRepository.update({ id: user.id }, { lastLoginSuccess: new Date(), sessionUuid });
    return this.tokenService.createToken(sessionUuid);
  }

  @Transactional()
  async checkToken(token: string): Promise<User> {
    const tokenPayload = await this.tokenService.decodeToken(token);

    if (!tokenPayload) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }

    const user = await this.userRepository.findOne({
      where: { sessionUuid: tokenPayload.sub },
      relations: { userUserRoles: true },
    });

    if (!user) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }

    if (!user.enabled) {
      throw new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE);
    }

    if (new Date().getTime() - user.lastAccess.getTime() > ms(this.configService.userIdleTimeout)) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }

    // Update last access
    await this.userRepository.update({ id: user.id }, {});

    return user;
  }

  @Transactional()
  async updateRoles(userRoleIds: UserRoleId[], userId: number): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new BadRequestException(USER_MISSING_MESSAGE);
    }

    await this.userUserRoleRepository.delete({ userId });

    const userRoles = await this.userRoleRepository.find({ where: { id: In(userRoleIds) } });

    if (userRoles.length < userRoleIds.length) {
      throw new BadRequestException("One of those roles doesn't exist. Choose roles from the list.");
    }

    for (const userRoleId of userRoleIds) {
      const userUserRole = new UserUserRole(user.id, userRoleId);
      await this.userUserRoleRepository.insert(userUserRole);
    }
  }

  @Transactional()
  async updateProfile(name: string, email: string, password: string | undefined, userId: number): Promise<void> {
    // Clean up email
    email = email.trim().toLowerCase();

    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new BadRequestException(USER_MISSING_MESSAGE);
    }

    if (user.email !== email) {
      const emailUser = await this.userRepository.findOne({ where: { email } });
      if (emailUser) {
        throw new BadRequestException(EMAIL_TAKEN_MESSAGE);
      }
    }

    const changes: Partial<Pick<User, 'name' | 'email' | 'passwordHash' | 'sessionUuid' | 'mustChangePassword'>> = {
      name,
      email,
    };

    if (password !== undefined) {
      if (user.mustChangePassword && (await bcrypt.compare(password, user.passwordHash))) {
        throw new BadRequestException('Choose a new password, not the one you signed in with.');
      }

      changes.passwordHash = await bcrypt.hash(password, this.configService.userPasswordHashRounds);
      changes.mustChangePassword = false;

      // A token issued against the old password stays valid until its session is dropped.
      changes.sessionUuid = null;
    }

    await this.userRepository.update({ id: user.id }, changes);
  }

  /**
   * Start a session for a user, replacing any session they already hold
   * @param user
   * @returns Token for the new session
   */
  async startSession(user: User): Promise<string> {
    const sessionUuid = uuidv4();

    await this.userRepository.update({ id: user.id }, { sessionUuid });

    return this.tokenService.createToken(sessionUuid);
  }

  /**
   * Invalidate users old sessionUuid this will log out any existing sessions
   * @param userId
   */
  async invalidateSessions(userId: number): Promise<void> {
    await this.userRepository.update({ id: userId }, { sessionUuid: null });
  }
}
