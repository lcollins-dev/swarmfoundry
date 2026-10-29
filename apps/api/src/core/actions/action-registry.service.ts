import { Injectable } from '@nestjs/common';

import { AgentActionService } from './agent-action.service';
import { IssueActionService } from './issue-action.service';

import type { IActionHandler } from './actions.types';
import type { IStepConfig, StepKind } from '@/core/foundry-config/foundry-config.types';

@Injectable()
export class ActionRegistryService {
  private readonly handlers: { [Kind in StepKind]: IActionHandler<Extract<IStepConfig, { kind: Kind }>> };

  constructor(agentActionService: AgentActionService, issueActionService: IssueActionService) {
    this.handlers = {
      agent: agentActionService,
      relabel: issueActionService,
      comment: issueActionService,
      assign: issueActionService,
    };
  }

  handlerOf(step: IStepConfig): IActionHandler<IStepConfig> {
    return this.handlers[step.kind];
  }

  /** Each handler once, though it serves several kinds. */
  all(): IActionHandler<IStepConfig>[] {
    return [...new Set(Object.values(this.handlers))];
  }
}
