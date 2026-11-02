import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ms from 'ms';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { PasswordLinkState } from '@libs/dto';

import { PasswordLink } from './entities/password-link.entity';
import { User } from './entities/user.entity';

import { ConfigService } from '@/config/config.service';
import { EmailService, EmailTemplate } from '@/email/email.service';

const TOKEN_BYTES = 32;

const INVITE_LIFETIME = '7 days';
const RESET_LIFETIME = '24 hours';

/** Kept past expiry so the page can still say a link expired rather than that it never existed. */
const RETENTION_MS = ms('30d');

export interface IIssuedPasswordLink {
  link: string;
  expiresAt: Date;
  emailed: boolean;
}

export interface IPasswordLinkCheck {
  state: PasswordLinkState;
  /** Set only for a valid link, carrying its user. */
  passwordLink: PasswordLink | null;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class PasswordLinkService {
  private readonly logger = new Logger(PasswordLinkService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    @InjectRepository(PasswordLink)
    private readonly passwordLinkRepository: Repository<PasswordLink>
  ) {}

  /**
   * Makes a link for the user and emails it, replacing any pending link they hold. A user without a password gets
   * an invite, anyone else a reset. Returns the link, the only place the raw token appears.
   */
  async issue(user: User): Promise<IIssuedPasswordLink> {
    const invite = user.passwordHash === null;
    const lifetime = invite ? INVITE_LIFETIME : RESET_LIFETIME;

    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const passwordLink = await this.replacePending(user.id, hashToken(token), new Date(Date.now() + ms(lifetime)));

    this.logger.log({ passwordLinkId: passwordLink.id, userId: user.id, invite }, 'issue(): Password link created');

    // A fragment never reaches the server, so the token stays out of the request logs.
    const link = `${this.configService.webAppBaseUrl.replace(/\/+$/, '')}/set-password#${token}`;

    const emailed = await this.emailService.sendEmail(
      user.email,
      invite ? EmailTemplate.INVITE : EmailTemplate.PASSWORD_RESET,
      { name: user.name, link, lifetime }
    );

    return { link, expiresAt: passwordLink.expiresAt, emailed };
  }

  /** A used link reads as used even once it has expired. */
  async check(token: string): Promise<IPasswordLinkCheck> {
    const passwordLink = await this.passwordLinkRepository.findOne({
      where: { tokenHash: hashToken(token) },
      relations: { user: true },
    });

    if (passwordLink?.user === undefined) {
      return { state: PasswordLinkState.INVALID, passwordLink: null };
    }

    if (passwordLink.usedAt !== null) {
      return { state: PasswordLinkState.USED, passwordLink: null };
    }

    if (passwordLink.expiresAt.getTime() <= Date.now()) {
      return { state: PasswordLinkState.EXPIRED, passwordLink: null };
    }

    return { state: PasswordLinkState.VALID, passwordLink };
  }

  /** False when the link is no longer pending, so only one request can use it. */
  async consume(passwordLink: PasswordLink): Promise<boolean> {
    const now = new Date();
    const result = await this.passwordLinkRepository.update(
      { id: passwordLink.id, usedAt: IsNull(), expiresAt: MoreThan(now) },
      { usedAt: now }
    );

    return (result.affected ?? 0) > 0;
  }

  async revoke(userId: number): Promise<void> {
    await this.passwordLinkRepository.delete(this.pendingWhere(userId));
  }

  @Transactional()
  private async replacePending(userId: number, tokenHash: string, expiresAt: Date): Promise<PasswordLink> {
    await this.passwordLinkRepository.delete({ expiresAt: LessThan(new Date(Date.now() - RETENTION_MS)) });
    await this.passwordLinkRepository.delete(this.pendingWhere(userId));

    const passwordLink = new PasswordLink({ tokenHash, userId, expiresAt });
    await this.passwordLinkRepository.insert(passwordLink);

    return passwordLink;
  }

  private pendingWhere(userId: number) {
    return { userId, usedAt: IsNull(), expiresAt: MoreThan(new Date()) };
  }
}
