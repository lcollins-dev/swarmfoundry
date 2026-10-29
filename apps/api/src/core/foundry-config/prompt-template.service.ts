import { Injectable } from '@nestjs/common';

import type { IPromptContext, IUnknownVariable, TriggerKind } from './foundry-config.types';
import { triggerKindOf } from './trigger-kind';

type Resolve = (context: IPromptContext) => string | undefined;

const SHARED_VARIABLES: [string, Resolve][] = [
  ['project.path', context => context.project.path],
  ['project.url', context => context.project.url],
  ['trigger.name', context => context.trigger.name],
  ['task.id', context => String(context.task.id)],
  ['run.id', context => String(context.run.id)],
];

const TEMPLATE_VARIABLES: Record<TriggerKind, ReadonlyMap<string, Resolve>> = {
  issue: new Map([
    ['issue.iid', context => (context.issue === undefined ? undefined : String(context.issue.iid))],
    ['issue.title', context => context.issue?.title],
    ['issue.url', context => context.issue?.url],
    ...SHARED_VARIABLES,
  ]),
  schedule: new Map([
    ['schedule.fireTime', context => context.schedule?.fireTime],
    ['schedule.previousFireTime', context => context.schedule?.previousFireTime],
    ['schedule.nextFireTime', context => context.schedule?.nextFireTime],
    ['schedule.lastRunStart', context => context.schedule?.lastRunStart],
    ['schedule.lastSuccessEnd', context => context.schedule?.lastSuccessEnd],
    ['schedule.lastFailureEnd', context => context.schedule?.lastFailureEnd],
    ...SHARED_VARIABLES,
  ]),
  mergeRequest: new Map([
    [
      'mergeRequest.iid',
      context => (context.mergeRequest === undefined ? undefined : String(context.mergeRequest.iid)),
    ],
    ['mergeRequest.url', context => context.mergeRequest?.url],
    ['mergeRequest.title', context => context.mergeRequest?.title],
    ['mergeRequest.sourceBranch', context => context.mergeRequest?.sourceBranch],
    ['mergeRequest.targetBranch', context => context.mergeRequest?.targetBranch],
    // Empty when the merge request relates to no issue.
    ['issue.iid', context => (context.issue === undefined ? '' : String(context.issue.iid))],
    ['issue.title', context => context.issue?.title ?? ''],
    ['issue.url', context => context.issue?.url ?? ''],
    ...SHARED_VARIABLES,
  ]),
};

/** Only a step of `failureSteps` may use these. */
const FAILURE_VARIABLES: ReadonlyMap<string, Resolve> = new Map([
  ['failure.report', context => context.failure?.report],
  ['failure.reason', context => context.failure?.reason],
]);

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

// GitLab runs a quick action from any line of a note that starts with `/`.
const LINE_START_SLASH = /^\//gm;

@Injectable()
export class PromptTemplateService {
  variableNames(kind: TriggerKind, failure: boolean): readonly string[] {
    return [...TEMPLATE_VARIABLES[kind].keys(), ...(failure ? FAILURE_VARIABLES.keys() : [])];
  }

  findUnknownVariables(template: string, kind: TriggerKind, failure: boolean): IUnknownVariable[] {
    const unknown: IUnknownVariable[] = [];

    for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
      const variable = match[1];

      if (!TEMPLATE_VARIABLES[kind].has(variable) && !(failure && FAILURE_VARIABLES.has(variable))) {
        const line = template.slice(0, match.index).split('\n').length;
        unknown.push({ name: variable, line });
      }
    }

    return unknown;
  }

  isFailureVariable(variable: string): boolean {
    return FAILURE_VARIABLES.has(variable);
  }

  /** One pass, so a value holding `{{...}}`, such as an issue title, is inserted as written. */
  render(template: string, context: IPromptContext): string {
    return this.renderWith(template, context, value => value);
  }

  /** Escapes a `/` that starts a line of a value, such as an issue title, so the note runs no quick action from it. */
  renderComment(template: string, context: IPromptContext): string {
    return this.renderWith(template, context, value => value.replace(LINE_START_SLASH, '\\/'));
  }

  private renderWith(template: string, context: IPromptContext, escape: (value: string) => string): string {
    const kind = triggerKindOf(context);

    return template.replace(PLACEHOLDER_PATTERN, (_placeholder, variable: string) => {
      const value = (TEMPLATE_VARIABLES[kind].get(variable) ?? FAILURE_VARIABLES.get(variable))?.(context);

      if (value === undefined && FAILURE_VARIABLES.has(variable)) {
        throw new Error(`render(): The task's failure could not be read, so {{${variable}}} cannot render`);
      }

      if (value === undefined) {
        throw new Error(`render(): Unknown template variable {{${variable}}} for a ${kind} prompt`);
      }

      return escape(value);
    });
  }
}
