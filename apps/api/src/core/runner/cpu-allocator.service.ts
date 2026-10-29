import { Injectable } from '@nestjs/common';

import type { ICpuMove } from './runner.types';

interface IAllocation {
  /** The agent's container name or id. */
  container: string;
  cores: readonly number[];
}

/** Held in memory only, so a restart forgets every allocation until recovery reserves it again. */
@Injectable()
export class CpuAllocatorService {
  private readonly allocations = new Map<number, IAllocation>();

  /** The least-used of `available`, capped at its length. Replaces what the run held before. */
  allocate(runId: number, container: string, count: number, available: readonly number[]): number[] {
    const cores = this.leastUsed(count, available, this.usage(available, runId));

    this.allocations.set(runId, { container, cores });

    return cores;
  }

  reserve(runId: number, container: string, cores: readonly number[]): void {
    this.allocations.set(runId, { container, cores: [...cores] });
  }

  /**
   * Frees the run's cores, then moves each run that shares a core onto less-used cores of the same count. Returns the
   * moves for the caller to apply to the containers.
   */
  release(runId: number, available: readonly number[]): ICpuMove[] {
    if (!this.allocations.delete(runId)) {
      return [];
    }

    const moves: ICpuMove[] = [];

    for (const [otherRunId, allocation] of [...this.allocations]) {
      const usage = this.usage(available, otherRunId);
      const load = (cores: readonly number[]) => cores.reduce((sum, core) => sum + (usage.get(core) ?? 0), 0);
      const cores = this.leastUsed(allocation.cores.length, available, usage);

      if (cores.length === allocation.cores.length && load(cores) < load(allocation.cores)) {
        this.allocations.set(otherRunId, { container: allocation.container, cores });
        moves.push({ runId: otherRunId, container: allocation.container, cores });
      }
    }

    return moves;
  }

  private leastUsed(count: number, available: readonly number[], usage: ReadonlyMap<number, number>): number[] {
    const usageOf = (core: number) => usage.get(core) ?? 0;

    return [...available]
      .sort((left, right) => (usageOf(left) === usageOf(right) ? left - right : usageOf(left) - usageOf(right)))
      .slice(0, count)
      .sort((left, right) => left - right);
  }

  private usage(available: readonly number[], exceptRunId: number): Map<number, number> {
    const usage = new Map(available.map(core => [core, 0]));

    for (const [runId, { cores }] of this.allocations) {
      for (const core of cores) {
        const used = usage.get(core);

        if (runId !== exceptRunId && used !== undefined) {
          usage.set(core, used + 1);
        }
      }
    }

    return usage;
  }
}
