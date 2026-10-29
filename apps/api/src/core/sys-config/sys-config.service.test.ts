import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SysConfig, SysConfigId } from '@/core/sys-config/entities/sys-config.entity';

import { SysConfigService } from '@/core/sys-config/sys-config.service';

vi.mock('typeorm-transactional', () => {
  const transactionalDecorator = () => () => undefined;
  return { Transactional: transactionalDecorator };
});

interface IRepositoryMock {
  find: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

describe('SysConfigService', () => {
  let sysConfigService: SysConfigService;
  let sysConfigRepository: IRepositoryMock;

  beforeEach(async () => {
    sysConfigRepository = { find: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [SysConfigService, { provide: getRepositoryToken(SysConfig), useValue: sysConfigRepository }],
    }).compile();

    sysConfigService = moduleRef.get(SysConfigService);
  });

  describe('getSysConfig', () => {
    it('parses the stored json into a boolean', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'true')]);

      const response = await sysConfigService.getSysConfig();

      expect(response).toEqual({ registrationEnabled: true });
    });

    it('reads a disabled flag as false', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'false')]);

      const response = await sysConfigService.getSysConfig();

      expect(response).toEqual({ registrationEnabled: false });
    });

    it('reads the config once and serves later calls from the cache', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'true')]);

      await sysConfigService.getSysConfig();
      await sysConfigService.getSysConfig();

      expect(sysConfigRepository.find).toHaveBeenCalledTimes(1);
    });

    it('throws when the stored value is not valid json', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'maybe')]);

      await expect(sysConfigService.getSysConfig()).rejects.toThrow(InternalServerErrorException);
    });

    it('throws when the registration entry is missing', async () => {
      sysConfigRepository.find.mockResolvedValue([]);

      await expect(sysConfigService.getSysConfig()).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('updateSysConfig', () => {
    it('stores the registration flag as json', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'false')]);

      await sysConfigService.updateSysConfig({ registrationEnabled: false });

      expect(sysConfigRepository.update).toHaveBeenCalledWith(
        { id: SysConfigId.REGISTRATION_ENABLED },
        { valueJson: 'false' }
      );
    });

    it('leaves the stored value alone when the request omits the flag', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'true')]);

      await sysConfigService.updateSysConfig({});

      expect(sysConfigRepository.update).not.toHaveBeenCalled();
    });

    it('refreshes the cache so the next read sees the new value', async () => {
      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'true')]);

      expect(await sysConfigService.getSysConfig()).toEqual({ registrationEnabled: true });

      sysConfigRepository.find.mockResolvedValue([new SysConfig(SysConfigId.REGISTRATION_ENABLED, 'false')]);

      await sysConfigService.updateSysConfig({ registrationEnabled: false });

      expect(await sysConfigService.getSysConfig()).toEqual({ registrationEnabled: false });
    });
  });
});
