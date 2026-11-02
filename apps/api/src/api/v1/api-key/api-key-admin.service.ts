import { Injectable } from '@nestjs/common';

import { ApiKeyDto, ApiKeyListResponseDto, CreateApiKeyRequestDto, CreateApiKeyResponseDto } from '@libs/dto';

import { ApiKey } from '@/core/api-key/entities/api-key.entity';

import { ApiKeyService } from '@/core/api-key/api-key.service';
import { UserService } from '@/core/user/user.service';

@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly userService: UserService
  ) {}

  async getApiKeyList(userId: number): Promise<ApiKeyListResponseDto> {
    const apiKeys = await this.apiKeyService.findForUser(userId);

    return { apiKeyList: apiKeys.map(apiKey => this.toApiKey(apiKey)) };
  }

  async getUserApiKeyList(userId: number): Promise<ApiKeyListResponseDto> {
    await this.userService.findWithThrow(userId);

    return this.getApiKeyList(userId);
  }

  async createApiKey(createApiKeyRequest: CreateApiKeyRequestDto, userId: number): Promise<CreateApiKeyResponseDto> {
    const { apiKey, token } = await this.apiKeyService.issue(createApiKeyRequest.name, userId);

    return { apiKey: this.toApiKey(apiKey), token };
  }

  revokeApiKey(apiKeyId: number): Promise<void> {
    return this.apiKeyService.revoke(apiKeyId);
  }

  private toApiKey(apiKey: ApiKey): ApiKeyDto {
    return {
      id: apiKey.id,
      name: apiKey.name,
      lastUsedDate: apiKey.lastUsedDate,
      createdDate: apiKey.createdDate,
    };
  }
}
