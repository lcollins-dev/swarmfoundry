import type { RunDto } from '@libs/dto';

import type { Run } from '@/core/task/entities/run.entity';

export function toRunDto(run: Run): RunDto {
  return {
    id: run.id,
    taskId: run.taskId,
    list: run.list,
    step: run.step,
    number: run.number,
    outcome: run.outcome,
    endReason: run.endReason,
    exitCode: run.exitCode,
    configSha: run.config?.sha ?? null,
    startDate: run.startDate,
    endDate: run.endDate,
    error: run.error,
    agent:
      run.agentName === null || run.agentModel === null || run.agentAuth === null
        ? null
        : { name: run.agentName, model: run.agentModel, auth: run.agentAuth },
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costUsd: run.costUsd,
  };
}
