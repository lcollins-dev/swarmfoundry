import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigRevision } from '@/core/foundry-config/entities/config-revision.entity';

import { ConfigAdminService } from './config-admin.service';
import type { ConfigFilesService, IConfigSnapshot } from '@/core/foundry-config/config-files.service';
import type { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import type { TaskReadService } from '@/core/task/task-read.service';

import { ConfigRevisionStatus } from '@/core/foundry-config/types/foundry-config.types';

const RUNNING = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

const snapshotOf = (sha: string | null): IConfigSnapshot => ({
  sha,
  currentDate: null,
  files: [{ path: 'swarmfoundry.yaml', content: 'sources: {}' }],
});

describe('ConfigAdminService', () => {
  let runningSha: string | null;
  let used: boolean;
  let configFiles: {
    readRunning: ReturnType<typeof vi.fn<ConfigFilesService['readRunning']>>;
    findRevision: ReturnType<typeof vi.fn<ConfigFilesService['findRevision']>>;
    read: ReturnType<typeof vi.fn<ConfigFilesService['read']>>;
  };
  let service: ConfigAdminService;

  beforeEach(() => {
    runningSha = RUNNING;
    used = true;

    configFiles = {
      readRunning: vi.fn<ConfigFilesService['readRunning']>(() => Promise.resolve(snapshotOf(runningSha))),
      findRevision: vi.fn<ConfigFilesService['findRevision']>(sha => {
        const revision = new ConfigRevision({
          sha,
          status: ConfigRevisionStatus.LOADED,
          errors: [],
          seenDate: new Date(),
        });
        revision.id = 4;

        return Promise.resolve(sha === OLDER ? revision : null);
      }),
      read: vi.fn<ConfigFilesService['read']>(revision => Promise.resolve(snapshotOf(revision.sha))),
    };

    service = new ConfigAdminService(
      {
        get revision() {
          return runningSha;
        },
      } as FoundryConfigService,
      configFiles as unknown as ConfigFilesService,
      { isConfigUsed: () => Promise.resolve(used) } as unknown as TaskReadService
    );
  });

  it('serves the running config without a sha, or by its own', async () => {
    await expect(service.getConfig({})).resolves.toMatchObject({ sha: RUNNING });
    await expect(service.getConfig({ sha: RUNNING })).resolves.toMatchObject({ sha: RUNNING });
    expect(configFiles.findRevision).not.toHaveBeenCalled();
  });

  it('serves an older revision a task ran on', async () => {
    await expect(service.getConfig({ sha: OLDER })).resolves.toMatchObject({ sha: OLDER });
  });

  it.each([
    ['no task ran on', OLDER, false],
    ['never reached a verdict', 'c'.repeat(40), true],
  ])('refuses with a 404 a revision that %s', async (_name, sha, taskRan) => {
    used = taskRan;

    await expect(service.getConfig({ sha })).rejects.toThrow(NotFoundException);
    expect(configFiles.read).not.toHaveBeenCalled();
  });

  it('refuses with a 404 when no config file is running', async () => {
    runningSha = null;
    configFiles.readRunning.mockResolvedValue(null);

    await expect(service.getConfig({})).rejects.toThrow(NotFoundException);
  });
});
