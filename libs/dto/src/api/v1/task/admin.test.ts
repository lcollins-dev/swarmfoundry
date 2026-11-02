import { describe, expect, it } from 'vitest';

import { TaskListQueryDto, TranscriptDirection, TranscriptEventType, TranscriptQueryDto } from './admin';
import { TaskStatus } from './task';

describe('TaskListQueryDto', () => {
  it('reads the page and each filter from the query string', () => {
    expect(
      TaskListQueryDto.parse({ page: '2', status: 'failed', trigger: 'implement', project: 'group/project' })
    ).toEqual({ page: 2, status: TaskStatus.FAILED, trigger: 'implement', project: 'group/project' });
  });

  it('refuses a status it does not know', () => {
    expect(TaskListQueryDto.safeParse({ page: '1', status: 'paused' }).success).toBe(false);
  });
});

describe('TranscriptQueryDto', () => {
  it('reads forward of every type by default', () => {
    expect(TranscriptQueryDto.parse({})).toEqual({ direction: TranscriptDirection.FORWARD });
  });

  it('splits the types on commas', () => {
    expect(TranscriptQueryDto.parse({ fromLine: '40', types: 'toolCall,toolResult' })).toEqual({
      direction: TranscriptDirection.FORWARD,
      fromLine: 40,
      types: [TranscriptEventType.TOOL_CALL, TranscriptEventType.TOOL_RESULT],
    });
  });

  it('reads backward from a line or from the end', () => {
    expect(TranscriptQueryDto.parse({ direction: 'backward', beforeLine: '12' })).toEqual({
      direction: TranscriptDirection.BACKWARD,
      beforeLine: 12,
    });
    expect(TranscriptQueryDto.parse({ direction: 'backward' })).toEqual({ direction: TranscriptDirection.BACKWARD });
  });

  it.each([
    ['a type it does not know', { types: 'toolCall,thinking' }],
    ['a line before the first', { fromLine: '0' }],
    ['a direction it does not know', { direction: 'sideways' }],
    ['a line to read backward from while reading forward', { beforeLine: '4' }],
    ['a line to read forward from while reading backward', { direction: 'backward', fromLine: '4' }],
  ])('refuses %s', (_name, query) => {
    expect(TranscriptQueryDto.safeParse(query).success).toBe(false);
  });
});
