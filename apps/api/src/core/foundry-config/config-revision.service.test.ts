import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigRevision } from './entities/config-revision.entity';

import { ConfigRevisionService } from './config-revision.service';

import { ConfigRevisionStatus } from './foundry-config.types';

const SHA = 'a'.repeat(40);

describe('ConfigRevisionService', () => {
  let values: ReturnType<typeof vi.fn<(revision: ConfigRevision) => void>>;
  let execute: ReturnType<typeof vi.fn>;
  let service: ConfigRevisionService;

  beforeEach(() => {
    values = vi.fn<(revision: ConfigRevision) => void>();
    execute = vi.fn().mockResolvedValue({ identifiers: [{ id: 7 }] });

    const query = {
      insert: () => query,
      into: () => query,
      values: (revision: ConfigRevision) => {
        values(revision);

        return query;
      },
      orUpdate: () => query,
      returning: () => query,
      execute,
    };

    service = new ConfigRevisionService({ createQueryBuilder: () => query } as unknown as Repository<ConfigRevision>);
  });

  it('records a revision with no errors as loaded, returning its id', async () => {
    await expect(service.recordLoad(SHA, [])).resolves.toBe(7);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ sha: SHA, status: ConfigRevisionStatus.LOADED, errors: [] })
    );
  });

  it('records a revision with errors as failed, keeping each error', async () => {
    const issues = [{ path: 'triggers.implement.prompt', message: 'is not a file' }];

    await service.recordLoad(SHA, issues);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ sha: SHA, status: ConfigRevisionStatus.FAILED, errors: issues })
    );
  });

  it('rejects when the write returns no id, so nothing pins a revision without a row', async () => {
    execute.mockResolvedValue({ identifiers: [] });

    await expect(service.recordLoad(SHA, [])).rejects.toThrow(`Recording revision ${SHA} returned no id`);
  });
});
