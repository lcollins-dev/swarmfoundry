import { beforeEach, describe, expect, it } from 'vitest';

import { CpuAllocatorService } from './cpu-allocator.service';

const cores = (count: number, first = 0) => Array.from({ length: count }, (_, offset) => first + offset);

describe('CpuAllocatorService', () => {
  let allocator: CpuAllocatorService;

  beforeEach(() => {
    allocator = new CpuAllocatorService();
  });

  it('spreads concurrent runs across the cores before sharing any', () => {
    expect(allocator.allocate(1, 'a1', 4, cores(16))).toEqual([0, 1, 2, 3]);
    expect(allocator.allocate(2, 'a2', 4, cores(16))).toEqual([4, 5, 6, 7]);
    expect(allocator.allocate(3, 'a3', 8, cores(16))).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(allocator.allocate(4, 'a4', 2, cores(16))).toEqual([0, 1]);
  });

  it('hands out the least-used cores once every core is shared', () => {
    expect(allocator.allocate(1, 'a1', 3, cores(4))).toEqual([0, 1, 2]);
    expect(allocator.allocate(2, 'a2', 3, cores(4))).toEqual([0, 1, 3]);
    expect(allocator.allocate(3, 'a3', 2, cores(4))).toEqual([2, 3]);
  });

  it('allocates only from the available cores', () => {
    expect(allocator.allocate(1, 'a1', 2, cores(4, 2))).toEqual([2, 3]);
    expect(allocator.allocate(2, 'a2', 2, cores(4, 2))).toEqual([4, 5]);
  });

  it('replaces what a run held when it allocates again', () => {
    allocator.allocate(1, 'a1', 4, cores(8));

    expect(allocator.allocate(1, 'a1', 4, cores(8))).toEqual([0, 1, 2, 3]);
  });

  it('hands out every core when asked for more than the daemon has', () => {
    expect(allocator.allocate(1, 'a1', 32, cores(4))).toEqual([0, 1, 2, 3]);
  });

  it('avoids reserved cores, and ignores any the daemon does not have', () => {
    allocator.reserve(1, 'kept', [0, 1, 9]);

    expect(allocator.allocate(2, 'a2', 2, cores(4))).toEqual([2, 3]);
  });

  describe('release', () => {
    it('frees a run’s cores for the next run', () => {
      allocator.allocate(1, 'a1', 4, cores(8));
      allocator.allocate(2, 'a2', 4, cores(8));

      expect(allocator.release(1, cores(8))).toEqual([]);
      expect(allocator.allocate(3, 'a3', 4, cores(8))).toEqual([0, 1, 2, 3]);
    });

    it('moves runs that share a core onto the freed cores, keeping their core count', () => {
      allocator.allocate(1, 'a1', 2, cores(4));
      allocator.allocate(2, 'a2', 2, cores(4));
      allocator.allocate(3, 'a3', 2, cores(4));

      expect(allocator.release(2, cores(4))).toEqual([{ runId: 1, container: 'a1', cores: [2, 3] }]);
      expect(allocator.allocate(4, 'a4', 2, cores(4))).toEqual([0, 1]);
    });

    it('moves a reserved run too', () => {
      allocator.reserve(1, 'kept', [0, 1]);
      allocator.allocate(2, 'a2', 2, cores(4));
      allocator.reserve(3, 'kept3', [0, 1]);

      expect(allocator.release(2, cores(4))).toEqual([{ runId: 1, container: 'kept', cores: [2, 3] }]);
    });

    it('moves nothing when no core is shared, or the run held none', () => {
      allocator.allocate(1, 'a1', 2, cores(8));
      allocator.allocate(2, 'a2', 2, cores(8));

      expect(allocator.release(1, cores(8))).toEqual([]);
      expect(allocator.release(9, cores(8))).toEqual([]);
    });

    it('moves nothing when the available cores are unknown', () => {
      allocator.reserve(1, 'kept', [0, 1]);
      allocator.reserve(2, 'kept2', [0, 1]);
      allocator.reserve(3, 'kept3', [2, 3]);

      expect(allocator.release(3, [])).toEqual([]);
    });
  });
});
