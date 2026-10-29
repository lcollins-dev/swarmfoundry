import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { z } from 'zod';

import { SysConfig, SysConfigId } from './entities/sys-config.entity';

export interface ISysConfig {
  registrationEnabled: boolean;
}

@Injectable()
export class SysConfigService {
  private readonly logger = new Logger(SysConfigService.name);

  private sysConfigList: SysConfig[] | null = null;

  constructor(
    @InjectRepository(SysConfig)
    private readonly sysConfigRepository: Repository<SysConfig>
  ) {}

  async getSysConfig(): Promise<ISysConfig> {
    this.sysConfigList ??= await this.sysConfigRepository.find();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const stored = this.sysConfigList.find(sysConfig => sysConfig.id === SysConfigId.REGISTRATION_ENABLED)?.valueJson;

    try {
      return {
        registrationEnabled: z.boolean().parse(JSON.parse(stored ?? '')),
      };
    } catch (error) {
      this.logger.error({ error }, 'getSysConfig(): Failed to parse config');
      throw new InternalServerErrorException();
    }
  }

  @Transactional()
  async updateSysConfig(changes: Partial<ISysConfig>) {
    if (changes.registrationEnabled !== undefined) {
      await this.sysConfigRepository.update(
        { id: SysConfigId.REGISTRATION_ENABLED },
        { valueJson: JSON.stringify(changes.registrationEnabled) }
      );
    }

    this.sysConfigList = await this.sysConfigRepository.find();
  }
}
