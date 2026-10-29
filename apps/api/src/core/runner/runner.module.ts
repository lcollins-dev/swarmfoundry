import { Module } from '@nestjs/common';
import Docker from 'dockerode';

import { AgentOutputService } from './agent-output.service';
import { AgentRunnerService } from './agent-runner.service';
import { CommandLimitService } from './command-limit.service';
import { CpuAllocatorService } from './cpu-allocator.service';
import { GitIdentityService } from './git-identity.service';
import { SandboxArchiveService } from './sandbox-archive.service';
import { SandboxService } from './sandbox.service';

import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';
import { TaskModule } from '@/core/task/task.module';

import { DOCKER_CLIENT } from './runner.types';
import { AGENT_RUNNER } from '@/core/actions/actions.types';

@Module({
  imports: [FoundryConfigModule, TaskModule],
  providers: [
    // DOCKER_HOST, or the default socket: the host's daemon, mounted into the orchestrator's container.
    { provide: DOCKER_CLIENT, useFactory: (): Docker => new Docker() },
    { provide: AGENT_RUNNER, useExisting: AgentRunnerService },
    AgentOutputService,
    AgentRunnerService,
    CommandLimitService,
    CpuAllocatorService,
    GitIdentityService,
    SandboxArchiveService,
    SandboxService,
  ],
  exports: [AGENT_RUNNER, SandboxService],
})
export class RunnerModule {}
