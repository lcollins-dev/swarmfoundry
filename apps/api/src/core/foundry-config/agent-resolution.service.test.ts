import { beforeEach, describe, expect, it } from 'vitest';

import { AgentResolutionService } from '@/core/foundry-config/agent-resolution.service';

import type { IAgentDefinition } from '@/core/foundry-config/foundry-config.types';

const definitions: Record<string, IAgentDefinition> = {
  subscription: { type: 'claude', auth: 'oauth', token: 'oauth-token', model: 'claude-opus-5-5', settings: './a.json' },
  api: { type: 'claude', auth: 'apiKey', token: 'api-key', model: 'claude-sonnet-5-5' },
};

const environmentLayer = (block: Record<string, unknown>) => ({
  path: ['environments', 'node', 'agent'],
  block,
});

const triggerLayer = (block: Record<string, unknown>) => ({
  path: ['triggers', 'review', 'agent'],
  block,
});

describe('AgentResolutionService', () => {
  let agentResolutionService: AgentResolutionService;

  beforeEach(() => {
    agentResolutionService = new AgentResolutionService();
  });

  describe('resolve', () => {
    it('takes the definition the environment names', () => {
      const result = agentResolutionService.resolve(definitions, [environmentLayer({ name: 'subscription' })]);

      expect(result).toMatchObject({ ok: true, resolution: { name: 'subscription', agent: definitions.subscription } });
    });

    it("keeps the environment's credentials when the trigger overrides only the model", () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ model: 'claude-haiku-5-5' }),
        environmentLayer({ name: 'subscription' }),
      ]);

      expect(result).toMatchObject({
        ok: true,
        resolution: {
          name: 'subscription',
          agent: { auth: 'oauth', token: 'oauth-token', model: 'claude-haiku-5-5', settings: './a.json' },
        },
      });
    });

    it('lets a trigger name another agent, merging over its definition', () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ name: 'api', model: 'claude-opus-5-5' }),
        environmentLayer({ name: 'subscription' }),
      ]);

      expect(result).toMatchObject({
        ok: true,
        resolution: { name: 'api', agent: { auth: 'apiKey', token: 'api-key', model: 'claude-opus-5-5' } },
      });
    });

    it("ignores the environment's overrides when the trigger names another agent", () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ name: 'api' }),
        environmentLayer({ name: 'subscription', auth: 'oauth', token: 'environment-oauth-token', model: 'env-model' }),
      ]);

      if (!result.ok) {
        throw new Error('expected the agent to resolve');
      }

      expect(result.resolution.agent).toEqual(definitions.api);
    });

    it("applies the environment's overrides when the trigger names the same agent", () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ name: 'subscription' }),
        environmentLayer({ name: 'subscription', model: 'env-model' }),
      ]);

      expect(result).toMatchObject({ ok: true, resolution: { agent: { model: 'env-model' } } });
    });

    it('takes each field from the most specific block that sets it', () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ model: 'trigger-model' }),
        environmentLayer({ name: 'subscription', model: 'environment-model', settings: './environment.json' }),
      ]);

      expect(result).toMatchObject({
        ok: true,
        resolution: { agent: { model: 'trigger-model', settings: './environment.json' } },
      });
    });

    it('records where each field came from', () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ model: 'trigger-model' }),
        environmentLayer({ name: 'subscription' }),
      ]);

      if (!result.ok) {
        throw new Error('expected the agent to resolve');
      }

      expect(result.resolution.origins.get('model')).toEqual(['triggers', 'review', 'agent', 'model']);
      expect(result.resolution.origins.get('token')).toEqual(['agents', 'subscription', 'token']);
    });

    it('refuses an agent that is not defined, naming the key', () => {
      expect(agentResolutionService.resolve(definitions, [triggerLayer({ name: 'missing' })])).toEqual({
        ok: false,
        issues: [{ path: 'triggers.review.agent.name', message: 'agent "missing" is not defined under agents' }],
      });
    });

    it('refuses blocks that name no agent', () => {
      expect(agentResolutionService.resolve(definitions, [triggerLayer({ model: 'x' })])).toEqual({
        ok: false,
        issues: [{ path: 'triggers.review.agent.name', message: 'must name an agent, here or on the environment' }],
      });
    });

    it('refuses an option the agent type does not define, at the block that set it', () => {
      const result = agentResolutionService.resolve(definitions, [
        triggerLayer({ plugins: ['./plugin'] }),
        environmentLayer({ name: 'subscription' }),
      ]);

      expect(result).toEqual({
        ok: false,
        issues: [{ path: 'triggers.review.agent.plugins', message: 'is not an option of agent type "claude"' }],
      });
    });

    it('refuses an invalid override at the block that set it', () => {
      const result = agentResolutionService.resolve(definitions, [
        environmentLayer({ name: 'subscription', auth: 'password' }),
      ]);

      expect(result).toMatchObject({ ok: false, issues: [{ path: 'environments.node.agent.auth' }] });
    });
  });

  describe('mergeFields', () => {
    it('replaces a list rather than appending to it', () => {
      const { fields, origins } = agentResolutionService.mergeFields('listed', { type: 'claude', extra: ['a', 'b'] }, [
        triggerLayer({ extra: ['c'] }),
        environmentLayer({ name: 'listed', extra: ['d', 'e'] }),
      ]);

      expect(fields.get('extra')).toEqual(['c']);
      expect(origins.get('extra')).toEqual(['triggers', 'review', 'agent', 'extra']);
    });

    it('never copies a block name into the fields', () => {
      const { fields } = agentResolutionService.mergeFields('api', definitions.api, [triggerLayer({ name: 'api' })]);

      expect(fields.has('name')).toBe(false);
    });
  });
});
