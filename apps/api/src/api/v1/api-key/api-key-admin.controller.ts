import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import {
  ApiKeyListResponseDto,
  CreateApiKeyRequestDto,
  CreateApiKeyResponseDto,
  IdParamDto,
  UserRoleId,
} from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { GetUser } from '../user/decorators/user.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { User } from '@/core/user/entities/user.entity';

import { ApiKeyAdminService } from './api-key-admin.service';

@Controller('api/v1/admin/api-key')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class ApiKeyAdminController {
  constructor(private readonly apiKeyAdminService: ApiKeyAdminService) {}

  @Get('list')
  getOwnApiKeyList(@GetUser() user: User): Promise<ApiKeyListResponseDto> {
    return this.apiKeyAdminService.getApiKeyList(user.id);
  }

  @Get('user/:userId')
  getUserApiKeyList(@Param('userId', new ZodPipe(IdParamDto)) userId: number): Promise<ApiKeyListResponseDto> {
    return this.apiKeyAdminService.getUserApiKeyList(userId);
  }

  @Post()
  createApiKey(
    @GetUser() user: User,
    @Body(new ZodPipe(CreateApiKeyRequestDto)) createApiKeyRequest: CreateApiKeyRequestDto
  ): Promise<CreateApiKeyResponseDto> {
    return this.apiKeyAdminService.createApiKey(createApiKeyRequest, user.id);
  }

  /** Revokes any user's key, not only the caller's. */
  @Delete(':apiKeyId')
  revokeApiKey(@Param('apiKeyId', new ZodPipe(IdParamDto)) apiKeyId: number): Promise<void> {
    return this.apiKeyAdminService.revokeApiKey(apiKeyId);
  }
}
