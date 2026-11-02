import { describe, expect, it } from 'vitest';

import { backLinkTo } from './backLink';

describe('backLinkTo', () => {
  it('names each console page a detail page can return to, keeping its query', () => {
    expect(backLinkTo('/queue')).toEqual({ to: '/queue', label: 'Queue' });
    expect(backLinkTo('/overview')).toEqual({ to: '/overview', label: 'Overview' });
    expect(backLinkTo('/tasks?status=failed&page=2')).toEqual({ to: '/tasks?status=failed&page=2', label: 'Tasks' });
    expect(backLinkTo('/tasks/1080')).toEqual({ to: '/tasks/1080', label: 'Task 1080' });
    expect(backLinkTo('/runs/3405')).toEqual({ to: '/runs/3405', label: 'Run 3405' });
    expect(backLinkTo('/triggers/dependency%20audit')).toEqual({
      to: '/triggers/dependency%20audit',
      label: 'dependency audit',
    });
  });

  it('names a config file by its path', () => {
    expect(backLinkTo('/config?file=prompts%2Fimplement%2Fprompt.md')).toEqual({
      to: '/config?file=prompts%2Fimplement%2Fprompt.md',
      label: 'prompts/implement/prompt.md',
    });
  });

  it('leaves out a page outside the console', () => {
    expect(backLinkTo('/sign-in')).toBeNull();
    expect(backLinkTo('/setup')).toBeNull();
  });
});
