import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ApiKey } from './entities/api-key.entity';
import { User } from '@/core/user/entities/user.entity';

import { API_KEY_PREFIX, ApiKeyTokenService } from './api-key-token.service';

const API_KEY_MISSING_MESSAGE = "This API key doesn't exist.";

const LAST_USED_STAMP_INTERVAL_MS = 60_000;

export interface IIssuedApiKey {
  apiKey: ApiKey;

  /** The only copy of the full key. Nothing stores it. */
  token: string;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyTokenService: ApiKeyTokenService,
    @InjectRepository(ApiKey) private readonly apiKeyRepository: Repository<ApiKey>
  ) {}

  isApiKey(token: string): boolean {
    return token.startsWith(API_KEY_PREFIX);
  }

  async issue(name: string, userId: number): Promise<IIssuedApiKey> {
    const { keyId, secretHash, token } = this.apiKeyTokenService.issue();

    const apiKey = new ApiKey({ keyId, name, secretHash, userId });
    await this.apiKeyRepository.insert(apiKey);

    this.logger.log({ apiKeyId: apiKey.id, userId }, 'issue(): API key created');

    return { apiKey, token };
  }

  /** Newest first. */
  findForUser(userId: number): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({ where: { userId }, order: { createdDate: 'DESC', id: 'DESC' } });
  }

  async revoke(apiKeyId: number): Promise<void> {
    const result = await this.apiKeyRepository.delete({ id: apiKeyId });

    if ((result.affected ?? 0) === 0) {
      throw new BadRequestException(API_KEY_MISSING_MESSAGE);
    }

    this.logger.log({ apiKeyId }, 'revoke(): API key revoked');
  }

  /**
   * Returns the owner with their roles, or null for any refusal, including an owner who is disabled, invited or held
   * to first-time setup. Stamps the key's `lastUsedDate` on success.
   */
  async verify(token: string): Promise<User | null> {
    const presented = this.apiKeyTokenService.parse(token);

    if (!presented) {
      return null;
    }

    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyId: presented.keyId },
      relations: { user: { userUserRoles: true } },
    });

    if (!apiKey?.user || !this.apiKeyTokenService.matches(presented.secret, apiKey.secretHash)) {
      return null;
    }

    const owner = apiKey.user;

    if (!owner.enabled || owner.mustChangePassword || owner.passwordHash === null) {
      return null;
    }

    await this.stampLastUsed(apiKey);

    return owner;
  }

  private async stampLastUsed(apiKey: ApiKey): Promise<void> {
    const now = new Date();

    if (apiKey.lastUsedDate !== null && now.getTime() - apiKey.lastUsedDate.getTime() < LAST_USED_STAMP_INTERVAL_MS) {
      return;
    }

    await this.apiKeyRepository.update({ id: apiKey.id }, { lastUsedDate: now });
  }
}
