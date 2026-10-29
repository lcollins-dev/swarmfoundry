import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ConfigRevision } from './entities/config-revision.entity';

import { ConfigRevisionStatus, type IConfigIssue } from './foundry-config.types';

@Injectable()
export class ConfigRevisionService {
  constructor(
    @InjectRepository(ConfigRevision)
    private readonly configRevisionRepository: Repository<ConfigRevision>
  ) {}

  /** Returns the revision's id. Keeps the first `seenDate`, and replaces the status and errors with this load's. */
  async recordLoad(sha: string, issues: readonly IConfigIssue[]): Promise<number> {
    const revision = new ConfigRevision({
      sha,
      status: issues.length === 0 ? ConfigRevisionStatus.LOADED : ConfigRevisionStatus.FAILED,
      errors: [...issues],
      seenDate: new Date(),
    });

    const result = await this.configRevisionRepository
      .createQueryBuilder()
      .insert()
      .into(ConfigRevision)
      .values(revision)
      .orUpdate(['status', 'errors'], ['sha'])
      .returning(['id'])
      .execute();

    // Postgres returns the row on a conflict too, so the id is the existing row's.
    const id: unknown = result.identifiers[0]?.id;

    if (typeof id !== 'number') {
      throw new Error(`Recording revision ${sha} returned no id`);
    }

    return id;
  }

  /** Keeps the first time. */
  async recordCurrent(id: number): Promise<void> {
    await this.configRevisionRepository.update({ id, currentDate: IsNull() }, { currentDate: new Date() });
  }

  async findSha(id: number): Promise<string | null> {
    const revision = await this.configRevisionRepository.findOneBy({ id });

    return revision?.sha ?? null;
  }
}
