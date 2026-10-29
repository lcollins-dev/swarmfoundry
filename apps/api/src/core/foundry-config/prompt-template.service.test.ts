import { beforeEach, describe, expect, it } from 'vitest';

import { PromptTemplateService } from '@/core/foundry-config/prompt-template.service';

import type { IPromptContext } from '@/core/foundry-config/foundry-config.types';

const issue = { iid: 42, title: 'Fix the poller', url: 'https://gitlab.example.com/acme/app/-/issues/42' };

const context: IPromptContext = {
  issue,
  project: { path: 'acme/app', url: 'https://gitlab.example.com/acme/app' },
  trigger: { name: 'implement' },
  task: { id: 5 },
  run: { id: 7 },
};

const scheduledContext: IPromptContext = {
  schedule: {
    fireTime: '2026-10-19T09:00:00.000Z',
    previousFireTime: '2026-10-12T09:00:00.000Z',
    nextFireTime: '2026-10-26T09:00:00.000Z',
    lastRunStart: '2026-10-12T09:00:05.000Z',
    lastSuccessEnd: '2026-10-12T09:20:00.000Z',
    lastFailureEnd: '',
  },
  project: { path: 'acme/app', url: 'https://gitlab.example.com/acme/app' },
  trigger: { name: 'friction' },
  task: { id: 6 },
  run: { id: 8 },
};

const mergeRequestContext: IPromptContext = {
  mergeRequest: {
    iid: 31,
    url: 'https://gitlab.example.com/acme/app/-/merge_requests/31',
    title: 'Fix the poller (#42)',
    sourceBranch: '42-fix-the-poller',
    targetBranch: 'master',
  },
  issue,
  project: { path: 'acme/app', url: 'https://gitlab.example.com/acme/app' },
  trigger: { name: 'merged' },
  task: { id: 6 },
  run: { id: 9 },
};

const MERGE_REQUEST_TEMPLATE =
  '!{{mergeRequest.iid}} {{mergeRequest.url}} "{{mergeRequest.title}}" {{mergeRequest.sourceBranch}} into ' +
  '{{mergeRequest.targetBranch}} for [{{issue.iid}}] [{{issue.title}}] [{{issue.url}}]';

const SCHEDULE_TEMPLATE =
  '{{schedule.fireTime}} {{schedule.previousFireTime}} {{schedule.nextFireTime}} {{schedule.lastRunStart}} ' +
  '{{schedule.lastSuccessEnd}} [{{schedule.lastFailureEnd}}]';

describe('PromptTemplateService', () => {
  let promptTemplateService: PromptTemplateService;

  beforeEach(() => {
    promptTemplateService = new PromptTemplateService();
  });

  describe('findUnknownVariables', () => {
    it('accepts every known variable', () => {
      const template =
        '{{issue.iid}} {{issue.title}} {{issue.url}} {{project.path}} {{project.url}} {{trigger.name}} {{task.id}} {{run.id}}';

      expect(promptTemplateService.findUnknownVariables(template, 'issue', false)).toEqual([]);
    });

    it('names an unknown variable and its line', () => {
      expect(
        promptTemplateService.findUnknownVariables('Line one\n{{issue.iid}} and {{issue.body}}', 'issue', false)
      ).toEqual([{ name: 'issue.body', line: 2 }]);
    });

    it('reads a placeholder with spaces inside the braces', () => {
      expect(promptTemplateService.findUnknownVariables('{{ issue.iid }} {{ secret }}', 'issue', false)).toEqual([
        { name: 'secret', line: 1 },
      ]);
    });

    it('refuses a prototype property name', () => {
      expect(promptTemplateService.findUnknownVariables('{{constructor}}', 'issue', false)).toEqual([
        { name: 'constructor', line: 1 },
      ]);
    });

    it('accepts the schedule variables and the shared ones in a scheduled prompt', () => {
      const template = `${SCHEDULE_TEMPLATE} {{project.path}} {{project.url}} {{trigger.name}} {{task.id}} {{run.id}}`;

      expect(promptTemplateService.findUnknownVariables(template, 'schedule', false)).toEqual([]);
    });

    it('accepts the merge request variables, the issue ones and the shared ones in a merge request prompt', () => {
      const template = `${MERGE_REQUEST_TEMPLATE} {{project.path}} {{project.url}} {{trigger.name}} {{task.id}} {{run.id}}`;

      expect(promptTemplateService.findUnknownVariables(template, 'mergeRequest', false)).toEqual([]);
    });

    it('refuses the schedule variables in a merge request prompt, and the merge request ones elsewhere', () => {
      expect(promptTemplateService.findUnknownVariables('{{schedule.fireTime}}', 'mergeRequest', false)).toEqual([
        { name: 'schedule.fireTime', line: 1 },
      ]);
      expect(promptTemplateService.findUnknownVariables('{{mergeRequest.iid}}', 'issue', false)).toEqual([
        { name: 'mergeRequest.iid', line: 1 },
      ]);
      expect(promptTemplateService.findUnknownVariables('{{mergeRequest.iid}}', 'schedule', false)).toEqual([
        { name: 'mergeRequest.iid', line: 1 },
      ]);
    });

    it('refuses the issue variables in a scheduled prompt, and the schedule variables in an issue prompt', () => {
      expect(promptTemplateService.findUnknownVariables('{{issue.title}}', 'schedule', false)).toEqual([
        { name: 'issue.title', line: 1 },
      ]);
      expect(promptTemplateService.findUnknownVariables('{{schedule.fireTime}}', 'issue', false)).toEqual([
        { name: 'schedule.fireTime', line: 1 },
      ]);
    });
  });

  describe('failure variables', () => {
    it('accepts {{failure.report}} and {{failure.reason}} only where the template is of failureSteps', () => {
      const template = '{{failure.report}} {{failure.reason}}';

      expect(promptTemplateService.findUnknownVariables(template, 'issue', true)).toEqual([]);
      expect(promptTemplateService.findUnknownVariables(template, 'mergeRequest', true)).toEqual([]);
      expect(promptTemplateService.findUnknownVariables(template, 'issue', false)).toEqual([
        { name: 'failure.report', line: 1 },
        { name: 'failure.reason', line: 1 },
      ]);
    });

    it('lists the failure variables among the known ones of failureSteps alone', () => {
      expect(promptTemplateService.variableNames('issue', true)).toContain('failure.report');
      expect(promptTemplateService.variableNames('issue', false)).not.toContain('failure.report');
    });

    it('renders the failure variables from the context', () => {
      const failure = { report: 'It failed.', reason: '` exit 1 `' };

      expect(promptTemplateService.render('{{failure.reason}}: {{failure.report}}', { ...context, failure })).toBe(
        '` exit 1 `: It failed.'
      );
    });

    it('throws on a failure variable with no failure in the context', () => {
      expect(() => promptTemplateService.render('{{failure.report}}', context)).toThrow(
        "render(): The task's failure could not be read, so {{failure.report}} cannot render"
      );
    });
  });

  describe('renderComment', () => {
    it('escapes a slash that starts a line of a value, so GitLab runs no quick action from it', () => {
      const rendered = promptTemplateService.renderComment('{{issue.title}}\n/label ~kept', {
        ...context,
        issue: { ...issue, title: '/close' },
      });

      expect(rendered).toBe('\\/close\n/label ~kept');
    });

    it('leaves a slash inside a value alone', () => {
      const rendered = promptTemplateService.renderComment('Merged {{issue.title}}', {
        ...context,
        issue: { ...issue, title: 'Fix a/b' },
      });

      expect(rendered).toBe('Merged Fix a/b');
    });
  });

  describe('render', () => {
    it('replaces every variable', () => {
      const rendered = promptTemplateService.render(
        'Issue #{{issue.iid}} "{{ issue.title }}" in {{project.path}} ({{project.url}}), {{issue.url}}, ' +
          '{{trigger.name}} task {{task.id}} run {{run.id}}',
        context
      );

      expect(rendered).toBe(
        'Issue #42 "Fix the poller" in acme/app (https://gitlab.example.com/acme/app), ' +
          'https://gitlab.example.com/acme/app/-/issues/42, implement task 5 run 7'
      );
    });

    it('replaces the schedule variables, an empty one with nothing', () => {
      expect(promptTemplateService.render(SCHEDULE_TEMPLATE, scheduledContext)).toBe(
        '2026-10-19T09:00:00.000Z 2026-10-12T09:00:00.000Z 2026-10-26T09:00:00.000Z 2026-10-12T09:00:05.000Z ' +
          '2026-10-12T09:20:00.000Z []'
      );
    });

    it('replaces the merge request variables and the related issue ones', () => {
      expect(promptTemplateService.render(MERGE_REQUEST_TEMPLATE, mergeRequestContext)).toBe(
        '!31 https://gitlab.example.com/acme/app/-/merge_requests/31 "Fix the poller (#42)" 42-fix-the-poller into ' +
          'master for [42] [Fix the poller] [https://gitlab.example.com/acme/app/-/issues/42]'
      );
    });

    it('renders the issue variables empty for a merge request that relates to no issue', () => {
      const withoutIssue = { ...mergeRequestContext, issue: undefined };

      expect(promptTemplateService.render('[{{issue.iid}}] [{{issue.title}}] [{{issue.url}}]', withoutIssue)).toBe(
        '[] [] []'
      );
    });

    it('inserts a value holding a placeholder as written', () => {
      const rendered = promptTemplateService.render('{{issue.title}}', {
        ...context,
        issue: { ...issue, title: '{{run.id}}' },
      });

      expect(rendered).toBe('{{run.id}}');
    });

    it('throws on an unknown variable', () => {
      expect(() => promptTemplateService.render('{{issue.body}}', context)).toThrow(/issue\.body/);
    });

    it('throws on an issue variable for a scheduled task', () => {
      expect(() => promptTemplateService.render('{{issue.title}}', scheduledContext)).toThrow(/issue\.title/);
    });
  });
});
