import { Injectable } from '@nestjs/common';

import { issueAt } from './foundry-config.error';
import type {
  AgentResolutionResult,
  IAgentDefinition,
  IAgentLayer,
  IMergedAgentFields,
  KeyPath,
} from './foundry-config.types';
import { agentDefinitionSchema } from './schema/agents';

@Injectable()
export class AgentResolutionService {
  /**
   * `layers` runs most specific first. The first block with a `name` picks the definition, and only blocks that name no
   * agent or the same one merge over it.
   */
  resolve(
    definitions: Readonly<Record<string, IAgentDefinition>>,
    layers: readonly IAgentLayer[]
  ): AgentResolutionResult {
    const named = layers.find(layer => layer.block.name !== undefined);

    if (named?.block.name === undefined) {
      const path = layers.length > 0 ? [...layers[0].path, 'name'] : [];

      return { ok: false, issues: [issueAt(path, 'must name an agent, here or on the environment')] };
    }

    const name = named.block.name;

    if (!Object.hasOwn(definitions, name)) {
      return { ok: false, issues: [issueAt([...named.path, 'name'], `agent "${name}" is not defined under agents`)] };
    }

    const applicable = layers.filter(layer => layer.block.name === undefined || layer.block.name === name);
    const { fields, origins } = this.mergeFields(name, definitions[name], applicable);

    const validated = agentDefinitionSchema.safeParse(Object.fromEntries(fields));

    if (!validated.success) {
      const originOf = (key: PropertyKey): KeyPath =>
        (typeof key === 'string' ? origins.get(key) : undefined) ?? [...named.path, String(key)];

      const issues = validated.error.issues.flatMap(issue => {
        if (issue.code === 'unrecognized_keys') {
          return issue.keys.map(key =>
            issueAt(originOf(key), `is not an option of agent type "${String(fields.get('type'))}"`)
          );
        }

        const path = issue.path.length === 0 ? named.path : [...originOf(issue.path[0]), ...issue.path.slice(1)];

        return [issueAt(path, issue.message)];
      });

      return { ok: false, issues };
    }

    return { ok: true, resolution: { name, agent: validated.data, origins } };
  }

  /** Each field, a list included, comes whole from the most specific of `layers` that sets it. */
  mergeFields(
    name: string,
    definition: Readonly<Record<string, unknown>>,
    layers: readonly IAgentLayer[]
  ): IMergedAgentFields {
    const fields = new Map<string, unknown>();
    const origins = new Map<string, KeyPath>();

    for (const [key, value] of Object.entries(definition)) {
      fields.set(key, value);
      origins.set(key, ['agents', name, key]);
    }

    for (const layer of [...layers].reverse()) {
      for (const [key, value] of Object.entries(layer.block)) {
        if (key !== 'name') {
          fields.set(key, value);
          origins.set(key, [...layer.path, key]);
        }
      }
    }

    return { fields, origins };
  }
}
