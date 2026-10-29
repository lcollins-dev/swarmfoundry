import { beforeEach, describe, expect, it } from 'vitest';

import { REDACTED, SecretRedactionService } from '@/core/foundry-config/secret-redaction.service';

describe('SecretRedactionService', () => {
  let secretRedactionService: SecretRedactionService;

  beforeEach(() => {
    secretRedactionService = new SecretRedactionService();
  });

  describe('collect', () => {
    it('collects tokens whole, whether literal or substituted', () => {
      const tree = {
        sources: { gitlab: { token: 'literal-source-token' } },
        agents: { claude: { token: 'substituted-token' } },
        environments: { node: { agent: { name: 'claude', token: 'environment-token' } } },
        triggers: {
          review: {
            steps: [{ agent: { prompt: './a.md' } }, { agent: { agent: { token: 'step-token' } } }],
            failureSteps: [{ comment: 'Failed' }, { agent: { agent: { token: 'failure-step-token' } } }],
          },
        },
      };

      expect(
        secretRedactionService.collect(tree, [
          { path: ['agents', 'claude', 'token'], value: 'substituted-token' },
          { path: ['triggers', 'review', 'steps', 0, 'agent', 'agent', 'token'], value: 'substituted-step-token' },
        ])
      ).toEqual(
        new Set([
          'substituted-token',
          'substituted-step-token',
          'literal-source-token',
          'environment-token',
          'step-token',
          'failure-step-token',
        ])
      );
    });

    it('collects substituted values in sandbox env, but not their literal values', () => {
      const tree = {
        environments: {
          node: {
            env: { GITLAB_TOKEN: 'agent-token', GITLAB_HOST: 'gitlab.example.com' },
            services: { postgres: { env: { POSTGRES_PASSWORD: 'db-password' } } },
          },
        },
      };

      const substitutions = [
        { path: ['environments', 'node', 'env', 'GITLAB_TOKEN'], value: 'agent-token' },
        { path: ['environments', 'node', 'services', 'postgres', 'env', 'POSTGRES_PASSWORD'], value: 'db-password' },
      ];

      expect(secretRedactionService.collect(tree, substitutions)).toEqual(new Set(['agent-token', 'db-password']));
    });

    it('leaves out a sandbox env value whose key names no secret, such as a username', () => {
      const substitutions = [
        { path: ['environments', 'node', 'env', 'FOUNDRY_BOT_USERNAME'], value: 'Swarmfoundry' },
        { path: ['environments', 'node', 'env', 'GIT_AUTHOR_NAME'], value: 'Swarmfoundry Bot' },
        { path: ['environments', 'node', 'env', 'ANTHROPIC_API_KEY'], value: 'sk-ant-api-secret' },
        { path: ['environments', 'node', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'], value: 'sk-ant-oat-secret' },
        { path: ['environments', 'node', 'services', 'db', 'env', 'db-pass'], value: 'db-password' },
      ];

      expect(secretRedactionService.collect({}, substitutions)).toEqual(
        new Set(['sk-ant-api-secret', 'sk-ant-oat-secret', 'db-password'])
      );
    });

    it('leaves out a sandbox env value too short to mask safely', () => {
      const substitutions = [
        { path: ['environments', 'node', 'env', 'DEBUG_TOKEN'], value: 'true' },
        { path: ['environments', 'node', 'services', 'postgres', 'env', 'POSTGRES_PASSWORD'], value: 'pg' },
        { path: ['agents', 'claude', 'token'], value: 'short' },
      ];

      expect(secretRedactionService.collect({}, substitutions)).toEqual(new Set(['short']));
    });

    it('leaves out a substituted value outside a secret position', () => {
      const substitutions = [
        { path: ['sources', 'gitlab', 'url'], value: 'https://gitlab.example.com' },
        { path: ['triggers', 'implement', 'concurrency'], value: '1' },
      ];

      expect(secretRedactionService.collect({}, substitutions)).toEqual(new Set());
    });
  });

  describe('redact', () => {
    it('masks a token field whatever its value', () => {
      expect(secretRedactionService.redact({ name: 'claude', token: 'literal-token' }, new Set())).toEqual({
        name: 'claude',
        token: REDACTED,
      });
    });

    it('masks a token field at any depth', () => {
      expect(secretRedactionService.redact({ agent: { token: 'deep' } }, new Set())).toEqual({
        agent: { token: REDACTED },
      });
    });

    it('masks a secret anywhere inside a string, in objects and lists', () => {
      const secrets = new Set(['s3cret']);

      expect(
        secretRedactionService.redact({ url: 'https://user:s3cret@example.com', list: ['s3cret'] }, secrets)
      ).toEqual({
        url: `https://user:${REDACTED}@example.com`,
        list: [REDACTED],
      });
    });

    it('leaves numbers and booleans alone', () => {
      expect(secretRedactionService.redact({ cpus: 4, comment: true }, new Set(['4']))).toEqual({
        cpus: 4,
        comment: true,
      });
    });
  });

  describe('redactText', () => {
    it('masks every occurrence of every secret', () => {
      expect(secretRedactionService.redactText('a-one b-one c-two', new Set(['one', 'two']))).toBe(
        `a-${REDACTED} b-${REDACTED} c-${REDACTED}`
      );
    });

    it('masks a secret that holds another one whole', () => {
      expect(secretRedactionService.redactText('token-abcdef', new Set(['abc', 'abcdef']))).toBe(`token-${REDACTED}`);
    });

    it('masks a secret escaped inside a JSON string', () => {
      const line = JSON.stringify({ output: 'token pass"word' });

      expect(secretRedactionService.redactText(line, new Set(['pass"word']))).toBe(`{"output":"token ${REDACTED}"}`);
    });

    it.each(['base64', 'base64url', 'hex'] as const)(
      'masks a secret encoded as %s, at any offset within the encoded data',
      encoding => {
        // '?>?' puts a '+' or '/' in the base64 at every offset, so base64url differs.
        const secret = 'sk-ant?>?token';

        for (const prefix of ['', 'a', 'ab']) {
          const encoded = Buffer.from(`${prefix}${secret}\n`).toString(encoding);
          const redacted = secretRedactionService.redactText(`echo ${encoded} done`, new Set([secret]));

          expect(redacted).toMatch(/^echo [\w+/=-]{0,4}\[redacted\][\w+/=-]{0,4} done$/);
        }
      }
    );

    it.each([
      ['base64', 76, '\n'],
      ['base64url', 76, '\r\n'],
      ['hex', 60, '\n'],
    ] as const)(
      'masks a long secret as %s wrapped at %i, as written and JSON-escaped',
      (encoding, width, lineBreak) => {
        const secret = `sk-ant-oat01-${'Xy7_q-'.repeat(16)}`;
        const encoded = Buffer.from(`${secret}\n`).toString(encoding);
        const wrapped = (encoded.match(new RegExp(`.{1,${width}}`, 'g')) ?? []).join(lineBreak);

        expect(secret.length).toBeGreaterThan(100);
        expect(wrapped).toContain(lineBreak);

        const raw = secretRedactionService.redactText(wrapped, new Set([secret]));
        const escaped = secretRedactionService.redactText(JSON.stringify({ output: wrapped }), new Set([secret]));

        expect(raw).toMatch(/^\[redacted\][\w+/=-]{0,4}$/);
        expect(escaped).toMatch(/^\{"output":"\[redacted\][\w+/=-]{0,4}"\}$/);
      }
    );

    it('masks upper-case hex', () => {
      const encoded = Buffer.from('agent-token').toString('hex').toUpperCase();

      expect(secretRedactionService.redactText(encoded, new Set(['agent-token']))).toBe(REDACTED);
    });

    it('leaves the encodings of a secret shorter than the minimum, so they mask no unrelated text', () => {
      const encoded = Buffer.from('short').toString('base64');

      expect(secretRedactionService.redactText(`short ${encoded}`, new Set(['short']))).toBe(`${REDACTED} ${encoded}`);
    });

    it('ignores an empty secret', () => {
      expect(secretRedactionService.redactText('text', new Set(['']))).toBe('text');
    });
  });
});
