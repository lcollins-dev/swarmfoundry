import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { SourceWatermark } from './entities/source-watermark.entity';
import type { WatermarkKind } from './entities/source-watermark.entity';

import type { ISourceConfig } from '@/core/foundry-config/foundry-config.types';

type ISource = Pick<ISourceConfig, 'name' | 'url'>;

@Injectable()
export class SourceWatermarkService {
  constructor(
    @InjectRepository(SourceWatermark)
    private readonly watermarkRepository: Repository<SourceWatermark>
  ) {}

  /** Null when the source has not polled the project for this kind yet. */
  async find(kind: WatermarkKind, source: ISource, projectId: number): Promise<Date | null> {
    const row = await this.watermarkRepository.findOneBy(this.keyOf(kind, source, projectId));

    return row?.watermark ?? null;
  }

  /** One statement, so two writes of one row cannot race into a unique violation. */
  async save(kind: WatermarkKind, source: ISource, projectId: number, watermark: Date): Promise<void> {
    const row = new SourceWatermark({ ...this.keyOf(kind, source, projectId), watermark });

    await this.watermarkRepository.upsert(row, ['kind', 'sourceName', 'gitlabUrl', 'projectId']);
  }

  /** Removes the source's rows of this kind for every other project, and every such row under another URL. */
  async retainProjects(kind: WatermarkKind, source: ISource, projectIds: readonly number[]): Promise<void> {
    const { sourceName, gitlabUrl } = this.keyOf(kind, source, 0);

    await this.watermarkRepository
      .createQueryBuilder()
      .delete()
      .from(SourceWatermark)
      .where('"kind" = :kind AND "sourceName" = :sourceName', { kind, sourceName })
      .andWhere('("gitlabUrl" <> :gitlabUrl OR NOT ("projectId" = ANY(:projectIds)))', {
        gitlabUrl,
        projectIds: [...projectIds],
      })
      .execute();
  }

  async removeProjects(kind: WatermarkKind, source: ISource, projectIds: readonly number[]): Promise<void> {
    const { sourceName, gitlabUrl } = this.keyOf(kind, source, 0);

    await this.watermarkRepository.delete({ kind, sourceName, gitlabUrl, projectId: In([...projectIds]) });
  }

  /** Removes every kind. */
  async retainSources(sourceNames: readonly string[]): Promise<void> {
    await this.watermarkRepository.delete({ sourceName: Not(In([...sourceNames])) });
  }

  private keyOf(kind: WatermarkKind, source: ISource, projectId: number) {
    return { kind, sourceName: source.name, gitlabUrl: source.url.replace(/\/+$/, ''), projectId };
  }
}
