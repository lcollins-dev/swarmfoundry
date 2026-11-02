import { Injectable } from '@nestjs/common';
import { isAlias, isPair, isScalar, isSeq, parseDocument, Scalar, visit } from 'yaml';

import type { IRedactionPatterns, ISubstitutedValue, KeyPath } from './types/foundry-config.types';

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

/** A commented-out YAML `key: value` line, up to where its value starts. */
const COMMENTED_KEY = /^\s*#[\s#-]*["']?([\w.-]+)["']?\s*:\s+/;

/** A YAML `key: value` line, with the value unquoted and any trailing comment dropped. */
const YAML_KEY_LINE = /^[\s-]*["']?([\w.-]+)["']?\s*:\s+["']?([^\s"'#|>&*{[][^"'#]*?)["']?\s*(?:#.*)?$/;

/**
 * The user information of each URL in a text, up to the last `@` before its host, as a URL parser reads it. A quote
 * ends it, so on a minified JSON line it cannot run on to a later field's `@`.
 */
const URL_USER_INFO = /[a-z][a-z\d+.-]*:\/\/([^/?#\s"']+)@/gi;

/** The credential of an auth header, with its scheme, written as `name: value` or `name=value`. */
const AUTH_HEADER =
  /\b((?:(?:Proxy-)?Authorization|(?:Private|Job|Deploy)-Token|X-Api-Key)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)(?![$[{]|(?:Bearer|Basic|Token)\s)[^\s,;"'\\]+/gi;

/** A token by the prefix its issuer gives it: GitLab, Anthropic and GitHub. */
const PREFIXED_TOKEN =
  /\b(?:gl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|oas|soat|ffct)-|sk-ant-|gh[opsur]_|github_pat_)[\w-]+/g;

/** A header value, as in `OTEL_EXPORTER_OTLP_HEADERS`, carries credentials under any name. */
const HEADERS_KEY = /headers$/i;

/** The agent's `auth` field names its auth mode, not a credential. */
const AUTH_MODE_PATHS = [
  ['agents', '*', 'auth'],
  ['environments', '*', 'agent', 'auth'],
  ['triggers', '*', 'steps', '*', 'agent', 'agent', 'auth'],
  ['triggers', '*', 'failureSteps', '*', 'agent', 'agent', 'auth'],
];

/** Run together into a longer word, as in `PGPASSWORD`, these still name a secret. */
const SECRET_WORD_PARTS = ['password', 'passwd', 'secret'];

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

/** Served files only, so a wider match cannot hide ordinary text in a live transcript. */
const WRITTEN_SECRET_KEY_WORDS = new Set([...SECRET_ENV_KEY_WORDS, 'pat', 'pwd']);

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

    this.walkStrings(tree, [], (value, path) => {
      if (value !== '' && this.matchesAny(path, TOKEN_PATHS)) {
        secrets.add(value);
      }
    });

    return secrets;
  }

  /**
   * The secrets from `MIN_SECRET_LENGTH` characters written into a config file as it stands, before `${VAR}` is
   * substituted: every literal token, every literal sandbox env value whose key names a secret, and the credentials of
   * any URL. `text` is scanned line by line for the same keys too, so a secret in a comment is found. A `${VAR}` reference
   * is left readable.
   */
  collectWritten(tree: unknown, text: string): Set<string> {
    const secrets = new Set<string>();

    this.walkStrings(tree, [], (value, path) => {
      const isEnvSecret = this.matchesAny(path, SANDBOX_ENV_PATHS) && this.namesWrittenSecret(String(path.at(-1)));

      if (this.matchesAny(path, TOKEN_PATHS) || isEnvSecret) {
        this.addWritten(secrets, value, MIN_SECRET_LENGTH);
      }

      this.addCredentials(secrets, value);
    });

    // Comments included, so an old connection string kept in one is masked.
    this.addCredentials(secrets, text);

    for (const line of text.split('\n')) {
      const pair = this.commentedPair(line) ?? YAML_KEY_LINE.exec(line)?.slice(1, 3);

      if (pair !== undefined && this.namesWrittenSecret(pair[0])) {
        this.addWritten(secrets, /^(["'])(.*)\1$/.exec(pair[1])?.[2] ?? pair[1], MIN_SECRET_LENGTH);
      }
    }

    return secrets;
  }

  /**
   * The secrets written into a file other than the config, such as a settings file's `env`: every literal value from
   * `MIN_SECRET_LENGTH` characters whose key names a secret, at any depth, and the credentials of any URL.
   */
  collectNamed(tree: unknown): Set<string> {
    const secrets = new Set<string>();

    this.walkStrings(tree, [], (value, path) => {
      if (this.namesWrittenSecret(String(path.at(-1) ?? ''))) {
        this.addWritten(secrets, value, MIN_SECRET_LENGTH);
      }

      this.addCredentials(secrets, value);
    });

    return secrets;
  }

  /**
   * Masks in place, whatever its length, each password in a URL, auth header credential and token with a known prefix.
   * A `${VAR}` reference is left readable.
   */
  maskCredentials(text: string): string {
    return text
      .replace(URL_USER_INFO, (match, userInfo: string) => {
        // Only the first colon ends the user, so a password may hold more.
        const separator = userInfo.indexOf(':');
        const password = userInfo.slice(separator + 1);

        if (separator === -1 || password === '' || password.includes('${')) {
          return match;
        }

        return `${match.slice(0, match.length - password.length - 1)}${REDACTED}@`;
      })
      .replace(AUTH_HEADER, `$1${REDACTED}`)
      .replace(PREFIXED_TOKEN, REDACTED);
  }

  /**
   * Masks in place, whatever its length, each literal value in a YAML or JSON text whose key names a secret or headers,
   * through an alias or on a commented-out key line too. The rest of the text is left as written. Unchanged when the
   * text does not parse.
   */
  maskKeyedValues(text: string): string {
    const document = parseDocument(text, { uniqueKeys: false });
    // By start, since several aliases can reach one anchored value.
    const ranges = new Map<number, [number, string]>();

    if (document.errors.length > 0) {
      return text;
    }

    visit(document, (_, node, ancestors) => {
      if (!isPair(node) || !isScalar(node.key)) {
        return;
      }

      const value = isAlias(node.value) ? node.value.resolve(document) : node.value;

      if (!isScalar(value) || !value.range || !this.masksKey(this.keyPath(ancestors, String(node.key.value)))) {
        return;
      }

      const [start, end] = value.range;
      const written = text.slice(start, end);

      if (written.trim() !== '' && !written.includes('${')) {
        ranges.set(start, [end, this.maskedScalar(value, written)]);
      }
    });

    // From the end, so each range still points at the text as written.
    const masked = [...ranges]
      .sort(([left], [right]) => right - left)
      .reduce((partly, [start, [end, value]]) => partly.slice(0, start) + value + partly.slice(end), text);

    // A comment is no node in the document, so a key commented out is found from its line.
    return masked
      .split('\n')
      .map(line => {
        const pair = this.commentedPair(line);

        if (pair === null || !this.masksKey([pair[0]]) || pair[1].includes('${')) {
          return line;
        }

        const [, value, start] = pair;

        return line.slice(0, start) + REDACTED + line.slice(start + value.length);
      })
      .join('\n');
  }

  /** The key, value and value's offset of a commented-out `key: value` line. YAML ends the value at a ` #`. */
  private commentedPair(line: string): [string, string, number] | null {
    const match = COMMENTED_KEY.exec(line);

    if (match === null) {
      return null;
    }

    const start = match[0].length;
    const end = line.slice(start).search(/\s#/);
    const value = line.slice(start, end === -1 ? undefined : start + end).trimEnd();

    return value === '' ? null : [match[1], value, start];
  }

  /** The keys down to a pair, with each list index as 0, which only a `*` matches. */
  private keyPath(ancestors: readonly unknown[], key: string): KeyPath {
    const keys = ancestors.flatMap((ancestor): PropertyKey[] =>
      isPair(ancestor) ? [isScalar(ancestor.key) ? String(ancestor.key.value) : ''] : isSeq(ancestor) ? [0] : []
    );

    return [...keys, key];
  }

  private masksKey(path: KeyPath): boolean {
    const key = String(path.at(-1));

    return !this.matchesAny(path, AUTH_MODE_PATHS) && (this.namesWrittenSecret(key) || HEADERS_KEY.test(key));
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

  /** A value of several lines also adds each, since a YAML block scalar's lines sit indented in the file. */
  private addWritten(secrets: Set<string>, value: string, minLength: number): void {
    if (value.includes('${') || value.length < minLength) {
      return;
    }

    secrets.add(value);

    // YAML writes an apostrophe inside single quotes doubled.
    if (value.includes("'")) {
      secrets.add(value.replaceAll("'", "''"));
    }

    for (const line of value.split('\n')) {
      if (line.trim().length >= MIN_SECRET_LENGTH && line.trim() !== value) {
        secrets.add(line.trim());
      }
    }
  }

  /** The user and password of each URL in `value`, as written, so the text holds them in the same form. */
  private addCredentials(secrets: Set<string>, value: string): void {
    for (const [, userInfo] of value.matchAll(URL_USER_INFO)) {
      // Only the first colon ends the user, so a password may hold more.
      const separator = userInfo.indexOf(':');
      const parts = separator === -1 ? [userInfo] : [userInfo.slice(0, separator), userInfo.slice(separator + 1)];

      for (const part of parts) {
        this.addWritten(secrets, part, MIN_SECRET_LENGTH);
      }
    }
  }

  /** Keeps a quoted scalar's quotes, so JSON stays JSON, and a block scalar's closing line break. */
  private maskedScalar(scalar: Scalar, written: string): string {
    if (scalar.type === Scalar.QUOTE_DOUBLE || scalar.type === Scalar.QUOTE_SINGLE) {
      return `${written[0]}${REDACTED}${written[0]}`;
    }

    return written.endsWith('\n') ? `${REDACTED}\n` : REDACTED;
  }

  /** Visits a number as its text too, since an env value written as a number reaches the sandbox as one. */
  private walkStrings(node: unknown, path: KeyPath, visit: (value: string, path: KeyPath) => void): void {
    if (typeof node === 'string' || typeof node === 'number') {
      visit(String(node), path);
    } else if (Array.isArray(node)) {
      node.forEach((item: unknown, index) => this.walkStrings(item, [...path, index], visit));
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        this.walkStrings(item, [...path, key], visit);
      }
    }
  }

  private namesSecret(envKey: string): boolean {
    return envKey
      .toLowerCase()
      .split(/[_.-]/)
      .some(word => SECRET_ENV_KEY_WORDS.has(word));
  }

  /** Splits camelCase too, so `privateKey` and `apiKeyHelper` name a key, and finds a password run into a word. */
  private namesWrittenSecret(key: string): boolean {
    return key
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[_.-]/)
      .some(word => WRITTEN_SECRET_KEY_WORDS.has(word) || SECRET_WORD_PARTS.some(part => word.includes(part)));
  }

  private matchesAny(path: KeyPath, patterns: readonly (readonly string[])[]): boolean {
    return patterns.some(
      pattern => pattern.length === path.length && pattern.every((segment, i) => segment === '*' || segment === path[i])
    );
  }
}
