import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

    it('keeps to its own key words, so a key only a served file reads as secret stays readable live', () => {
      const substitutions = [
        { path: ['environments', 'node', 'env', 'sortKey'], value: 'createdDate' },
        { path: ['environments', 'node', 'env', 'DB_PWD'], value: 'pwd-secret-value' },
        { path: ['environments', 'node', 'env', 'GITLAB_PAT'], value: 'pat-secret-value' },
      ];

      expect(secretRedactionService.collect({}, substitutions)).toEqual(new Set());
    });
  });

  describe('maskCredentials', () => {
    it('masks a URL password of any length, keeping the user and host', () => {
      expect(secretRedactionService.maskCredentials('postgres://bot:hunter3@db.example.com/app')).toBe(
        `postgres://bot:${REDACTED}@db.example.com/app`
      );
    });

    it('masks a password that holds an @ whole, as a URL parser reads it', () => {
      expect(secretRedactionService.maskCredentials('postgres://app:p@ssw0rd!x@db.example.com:5432/app')).toBe(
        `postgres://app:${REDACTED}@db.example.com:5432/app`
      );
    });

    it('leaves a URL with a user alone, or a ${VAR} password', () => {
      const text = 'ssh://git@gitlab.example.com/x.git https://bot:${DB_PASSWORD}@db.example.com';

      expect(secretRedactionService.maskCredentials(text)).toBe(text);
    });

    it('keeps a URL inside its JSON string, leaving a later field with an @ alone', () => {
      const text = '{"env":{"BASE_URL":"https://api.example.com","CONTACT":"bot@example.com"}}';

      expect(secretRedactionService.maskCredentials(text)).toBe(text);
    });

    it('masks an auth header credential, after its scheme', () => {
      const text = 'Authorization=Bearer s3cr3t-otlp-key,PRIVATE-TOKEN: abc123 -H "Authorization: Basic dXNlcjpwYXNz"';

      expect(secretRedactionService.maskCredentials(text)).toBe(
        `Authorization=Bearer ${REDACTED},PRIVATE-TOKEN: ${REDACTED} -H "Authorization: Basic ${REDACTED}"`
      );
    });

    it('masks an auth header credential written as JSON', () => {
      expect(secretRedactionService.maskCredentials('{"headers":{"Authorization":"Bearer abc123def456"}}')).toBe(
        `{"headers":{"Authorization":"Bearer ${REDACTED}"}}`
      );
    });

    it('leaves a header that reads its credential from a variable, and prose', () => {
      const text = 'Send Authorization: Bearer $GITLAB_TOKEN for basic usage.';

      expect(secretRedactionService.maskCredentials(text)).toBe(text);
    });

    it('masks a token by its prefix, wherever it sits', () => {
      expect(secretRedactionService.maskCredentials('Clone with glpat-promptsecret or sk-ant-short.')).toBe(
        `Clone with ${REDACTED} or ${REDACTED}.`
      );
    });
  });

  describe('collectWritten', () => {
    it('collects a written secret only from the minimum length, since it is masked wherever it appears', () => {
      const yaml = 'sources:\n  gl:\n    token: abc\n    # token: test\n    # DB_PASSWORD: "Xk9#mP2qL7"\n';

      expect([...secretRedactionService.collectWritten(parse(yaml), yaml)]).toEqual(['Xk9#mP2qL7']);
    });
  });

  describe('maskKeyedValues', () => {
    it('masks a value of any length under a secret key, in YAML and in JSON, and nothing else', () => {
      const yaml = [
        'env:',
        '  POSTGRES_PASSWORD: hunter2',
        "  DB_PWD: 'pw1'",
        '  GITLAB_HOST: gitlab.example.com',
        '  services: { db: { GITLAB_PAT: abc, PORT: 5432 } }',
        '',
      ].join('\n');
      const json = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-key=abc', GIT_HOST: 'gitlab.example.com' } });

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(
        [
          'env:',
          `  POSTGRES_PASSWORD: ${REDACTED}`,
          `  DB_PWD: '${REDACTED}'`,
          '  GITLAB_HOST: gitlab.example.com',
          `  services: { db: { GITLAB_PAT: ${REDACTED}, PORT: 5432 } }`,
          '',
        ].join('\n')
      );
      expect(JSON.parse(secretRedactionService.maskKeyedValues(json))).toEqual({
        env: { OTEL_EXPORTER_OTLP_HEADERS: REDACTED, GIT_HOST: 'gitlab.example.com' },
      });
    });

    it('masks a value of any length on a commented-out secret key line', () => {
      const yaml = 'env:\n  # POSTGRES_PASSWORD: hunter2  # old\n  # GITLAB_HOST: gitlab.example.com\n  A: b\n';

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(
        `env:\n  # POSTGRES_PASSWORD: ${REDACTED}  # old\n  # GITLAB_HOST: gitlab.example.com\n  A: b\n`
      );
    });

    it("leaves a ${VAR} reference and the agent's auth mode readable", () => {
      const yaml = 'agents:\n  claude:\n    auth: oauth\n    token: ${CLAUDE_TOKEN}\n';

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(yaml);
    });

    it('masks a commented-out value whole, up to a trailing comment, whatever it holds', () => {
      const yaml = `env:\n  # DB_PASSWORD: Xk9#mP2qL7  # old\n  # OLD_PASSWORD: pa"ss-w0rd!\n  A: b\n`;

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(
        `env:\n  # DB_PASSWORD: ${REDACTED}  # old\n  # OLD_PASSWORD: ${REDACTED}\n  A: b\n`
      );
    });

    it('masks a value a secret key reaches through an alias, where its anchor sits', () => {
      const yaml = 'x-pw: &pw hunter2\nenv:\n  DB_PASSWORD: *pw\n  OTHER_PASSWORD: *pw\n';

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(
        `x-pw: &pw ${REDACTED}\nenv:\n  DB_PASSWORD: *pw\n  OTHER_PASSWORD: *pw\n`
      );
    });

    it('masks an auth key anywhere but an agent', () => {
      const yaml = [
        'environments:',
        '  node:',
        '    agent: { auth: oauth }',
        '    services: { redis: { env: { auth: hunter4 } } }',
        'triggers:',
        '  implement:',
        '    steps:',
        '      - agent: { agent: { auth: apiKey } }',
        '',
      ].join('\n');

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(yaml.replace('auth: hunter4', `auth: ${REDACTED}`));
    });

    it('masks a block scalar whole, keeping the next key on its own line', () => {
      const yaml = 'DEPLOY_KEY: |\n  line-one\n  line-two\nNEXT: value\n';

      expect(secretRedactionService.maskKeyedValues(yaml)).toBe(`DEPLOY_KEY: ${REDACTED}\nNEXT: value\n`);
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
