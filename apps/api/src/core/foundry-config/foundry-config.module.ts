import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigRevision } from './entities/config-revision.entity';

import { AgentResolutionService } from './agent-resolution.service';
import { ConfigRepoGitService } from './config-repo-git.service';
import { ConfigRepoService } from './config-repo.service';
import { ConfigRevisionService } from './config-revision.service';
import { FoundryConfigLoaderService } from './foundry-config-loader.service';
import { FoundryConfigService } from './foundry-config.service';
import { PromptTemplateService } from './prompt-template.service';
import { SecretRedactionService } from './secret-redaction.service';
import { VariableSubstitutionService } from './variable-substitution.service';

@Module({
  imports: [TypeOrmModule.forFeature([ConfigRevision])],
  providers: [
    AgentResolutionService,
    ConfigRepoGitService,
    ConfigRepoService,
    ConfigRevisionService,
    FoundryConfigLoaderService,
    FoundryConfigService,
    PromptTemplateService,
    SecretRedactionService,
    VariableSubstitutionService,
  ],
  exports: [FoundryConfigService],
})
export class FoundryConfigModule {}
