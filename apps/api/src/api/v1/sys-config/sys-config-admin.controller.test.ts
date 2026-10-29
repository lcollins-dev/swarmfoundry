import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SysConfigService } from '@/core/sys-config/sys-config.service';

import { SysConfigAdminController } from '@/api/v1/sys-config/sys-config-admin.controller';

describe('SysConfigAdminController', () => {
  let controller: SysConfigAdminController;
  let getSysConfigMock: ReturnType<typeof vi.fn>;
  let updateSysConfigMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getSysConfigMock = vi.fn();
    updateSysConfigMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [SysConfigAdminController],
      providers: [
        {
          provide: SysConfigService,
          useValue: { getSysConfig: getSysConfigMock, updateSysConfig: updateSysConfigMock },
        },
      ],
    }).compile();

    controller = moduleRef.get(SysConfigAdminController);
  });

  it('returns the config from the service', async () => {
    getSysConfigMock.mockResolvedValue({ registrationEnabled: true });

    const response = await controller.getSysConfig();

    expect(response).toEqual({ registrationEnabled: true });
  });

  it('passes the body through to the service on update', async () => {
    updateSysConfigMock.mockResolvedValue(undefined);

    const updateSysConfigRequest = { registrationEnabled: false };
    await controller.updateSysConfig(updateSysConfigRequest);

    expect(updateSysConfigMock).toHaveBeenCalledWith(updateSysConfigRequest);
  });
});
