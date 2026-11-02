import { Injectable, NotFoundException } from '@nestjs/common';

import type { ConfigQueryDto, ConfigResponseDto } from '@libs/dto';

import { ConfigFilesService, type IConfigSnapshot } from '@/core/foundry-config/config-files.service';
import { FoundryConfigService } from '@/core/foundry-config/foundry-config.service';
import { TaskReadService } from '@/core/task/task-read.service';

const CONFIG_MISSING_MESSAGE = 'No readable config is running, or no task ran on that revision.';

@Injectable()
export class ConfigAdminService {
  constructor(
    private readonly foundryConfigService: FoundryConfigService,
    private readonly configFilesService: ConfigFilesService,
    private readonly taskReadService: TaskReadService
  ) {}

  /** The running config, or a revision a task ran on. Any other revision may never have loaded, so it is refused. */
  async getConfig(query: ConfigQueryDto): Promise<ConfigResponseDto> {
    const snapshot =
      query.sha === undefined || query.sha === this.foundryConfigService.revision
        ? await this.configFilesService.readRunning()
        : await this.readUsedRevision(query.sha);

    if (snapshot === null) {
      throw new NotFoundException(CONFIG_MISSING_MESSAGE);
    }

    return snapshot;
  }

  private async readUsedRevision(sha: string): Promise<IConfigSnapshot | null> {
    const revision = await this.configFilesService.findRevision(sha);

    if (revision === null || !(await this.taskReadService.isConfigUsed(revision.id))) {
      return null;
    }

    return this.configFilesService.read(revision);
  }
}
