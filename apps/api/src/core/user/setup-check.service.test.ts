import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { User } from '@/core/user/entities/user.entity';

import { SetupCheckService } from '@/core/user/setup-check.service';

describe('SetupCheckService', () => {
  let find: ReturnType<typeof vi.fn>;
  let warn: MockInstance<Logger['warn']>;
  let service: SetupCheckService;

  beforeEach(() => {
    find = vi.fn().mockResolvedValue([]);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new SetupCheckService({ find } as unknown as Repository<User>);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('warns on every start while an account is still held to first-time setup', async () => {
    find.mockResolvedValue([{ email: 'admin@example.com' }]);

    await service.onApplicationBootstrap();

    expect(find).toHaveBeenCalledWith({ where: { mustChangePassword: true } });
    expect(warn).toHaveBeenCalledWith({ email: 'admin@example.com' }, expect.stringContaining('initial password'));
  });

  it('stays quiet once setup is finished', async () => {
    await service.onApplicationBootstrap();

    expect(warn).not.toHaveBeenCalled();
  });
});
