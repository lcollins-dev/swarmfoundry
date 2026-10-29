import { describe, expect, it } from 'vitest';

import { TaskListQueryDto, TranscriptEventType, TranscriptQueryDto } from './admin';
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
  it('reads from the first line of every type by default', () => {
    expect(TranscriptQueryDto.parse({})).toEqual({ fromLine: 1 });
  });

  it('splits the types on commas', () => {
    expect(TranscriptQueryDto.parse({ fromLine: '40', types: 'toolCall,toolResult' })).toEqual({
      fromLine: 40,
      types: [TranscriptEventType.TOOL_CALL, TranscriptEventType.TOOL_RESULT],
    });
  });

  it.each([
    ['a type it does not know', { types: 'toolCall,thinking' }],
    ['a line before the first', { fromLine: '0' }],
  ])('refuses %s', (_name, query) => {
    expect(TranscriptQueryDto.safeParse(query).success).toBe(false);
  });
});
