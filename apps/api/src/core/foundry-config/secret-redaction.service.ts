import { Injectable } from '@nestjs/common';

import type { IRedactionPatterns, ISubstitutedValue, KeyPath } from './foundry-config.types';

export const REDACTED = '[redacted]';

const SECRET_KEYS = new Set(['token']);

const TOKEN_PATHS = [
  ['sources', '*', 'token'],
  ['agents', '*', 'token'],
  ['environments', '*', 'agent', 'token'],
  ['triggers', '*', 'steps', '*', 'agent', 'agent', 'token'],
  ['triggers', '*', 'failureSteps', '*', 'agent', 'agent', 'token'],
];

/** A shorter env value or encoded secret, such as `true` or `5432`, would mask unrelated text everywhere it appears. */
export const MIN_SECRET_LENGTH = 8;

/**
 * An optional line break between two characters of an encoded secret, as written or as escaped inside a JSON string,
 * since `base64` and `xxd` wrap their output. The alternatives hold no quantifier, so matching stays linear.
 */
const LINE_BREAK = String.raw`(?:\n|\r\n|\\n|\\r\\n)?`;

const SANDBOX_ENV_PATHS = [
  ['environments', '*', 'env', '*'],
  ['environments', '*', 'services', '*', 'env', '*'],
];

const SECRET_ENV_KEY_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pass',
  'passphrase',
  'key',
  'apikey',
  'credential',
  'credentials',
  'auth',
  'oauth',
  'dsn',
]);

@Injectable()
export class SecretRedactionService {
  /**
   * Tokens count whole, literal or not. Other `${VAR}` values count only inside a sandbox env value whose key names a
   * secret, and only from `MIN_SECRET_LENGTH` characters.
   */
  collect(tree: unknown, substitutions: readonly ISubstitutedValue[]): Set<string> {
    const secrets = new Set<string>();

    for (const { path, value } of substitutions) {
      const isEnvSecret =
        this.matchesAny(path, SANDBOX_ENV_PATHS) &&
        this.namesSecret(String(path.at(-1))) &&
        value.length >= MIN_SECRET_LENGTH;

      if (this.matchesAny(path, TOKEN_PATHS) || isEnvSecret) {
        secrets.add(value);
      }
    }

    const walk = (node: unknown, path: KeyPath): void => {
      if (typeof node === 'string' && node !== '' && this.matchesAny(path, TOKEN_PATHS)) {
        secrets.add(node);
      } else if (Array.isArray(node)) {
        node.forEach((item: unknown, index) => walk(item, [...path, index]));
      } else if (typeof node === 'object' && node !== null) {
        for (const [key, item] of Object.entries(node)) {
          walk(item, [...path, key]);
        }
      }
    };

    walk(tree, []);

    return secrets;
  }

  /** Masks every `token` field, and every occurrence of a secret inside any string. */
  redact(value: unknown, secrets: ReadonlySet<string>): unknown {
    if (typeof value === 'string') {
      return this.redactText(value, secrets);
    }

    if (Array.isArray(value)) {
      return value.map((item: unknown) => this.redact(item, secrets));
    }

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.has(key) ? REDACTED : this.redact(item, secrets)])
      );
    }

    return value;
  }

  /** Compiles `secrets` for each call. Hold a `compile` result instead for text redacted often. */
  redactText(text: string, secrets: Iterable<string>): string {
    return this.apply(text, this.compile(secrets));
  }

  /**
   * Each secret as written and as escaped inside a JSON string, and from `MIN_SECRET_LENGTH` characters as base64,
   * base64url and hex, wrapped across lines or not.
   */
  compile(secrets: Iterable<string>): IRedactionPatterns {
    const plain = new Set<string>();
    const encoded = new Set<string>();

    for (const secret of secrets) {
      if (secret !== '') {
        plain.add(secret);
        plain.add(JSON.stringify(secret).slice(1, -1));
      }

      if (secret.length >= MIN_SECRET_LENGTH) {
        for (const form of this.encodedForms(secret)) {
          encoded.add(form);
        }
      }
    }

    // Longest first, so a secret that holds a shorter one is masked whole.
    const longestFirst = (forms: Set<string>) => [...forms].sort((left, right) => right.length - left.length);
    const alternatives = longestFirst(encoded).map(form => this.wrappable(form));

    return {
      plain: longestFirst(plain),
      encoded: alternatives.length === 0 ? null : new RegExp(alternatives.join('|'), 'g'),
    };
  }

  /** Masks the encoded forms first, so masking a plain secret cannot break up another secret's encoding. */
  apply(text: string, patterns: IRedactionPatterns): string {
    let redacted = patterns.encoded === null ? text : text.replace(patterns.encoded, REDACTED);

    for (const form of patterns.plain) {
      redacted = redacted.replaceAll(form, REDACTED);
    }

    return redacted;
  }

  /**
   * A secret's base64 depends on its byte offset within the encoded data, so each of the three offsets gets a form,
   * cut to the characters that hold only the secret's bits.
   */
  private encodedForms(secret: string): string[] {
    const bytes = Buffer.from(secret, 'utf8');
    const hex = bytes.toString('hex');
    const forms = [hex, hex.toUpperCase()];

    for (let offset = 0; offset < 3; offset++) {
      const padded = Buffer.concat([Buffer.alloc(offset), bytes, Buffer.alloc(2)]);
      const firstBit = offset * 8;
      const endBit = firstBit + bytes.length * 8;
      const base64 = padded.toString('base64').slice(Math.ceil(firstBit / 6), Math.floor(endBit / 6));

      forms.push(base64, base64.replaceAll('+', '-').replaceAll('/', '_'));
    }

    return forms;
  }

  /** `form` as a regex source with an optional `LINE_BREAK` between every two characters. */
  private wrappable(form: string): string {
    return form.replace(/[\s\S]/g, (char, offset: number) => {
      const escaped = char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

      return offset === 0 ? escaped : `${LINE_BREAK}${escaped}`;
    });
  }

  private namesSecret(envKey: string): boolean {
    return envKey
      .toLowerCase()
      .split(/[_.-]/)
      .some(word => SECRET_ENV_KEY_WORDS.has(word));
  }

  private matchesAny(path: KeyPath, patterns: readonly (readonly string[])[]): boolean {
    return patterns.some(
      pattern => pattern.length === path.length && pattern.every((segment, i) => segment === '*' || segment === path[i])
    );
  }
}
