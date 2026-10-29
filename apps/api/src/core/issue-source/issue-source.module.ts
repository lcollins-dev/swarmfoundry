import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SourceWatermark } from './entities/source-watermark.entity';

import { GitLabApiService } from './gitlab-api.service';
import { GitLabMergeRequestSourceService } from './gitlab-merge-request-source.service';
import { GitLabSourceService } from './gitlab-source.service';
import { IssueSourceService } from './issue-source.service';
import { SourceWatermarkService } from './source-watermark.service';

import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';

@Module({
  imports: [FoundryConfigModule, TypeOrmModule.forFeature([SourceWatermark])],
  providers: [
    IssueSourceService,
    GitLabSourceService,
    GitLabMergeRequestSourceService,
    GitLabApiService,
    SourceWatermarkService,
  ],
  exports: [IssueSourceService],
})
export class IssueSourceModule {}
