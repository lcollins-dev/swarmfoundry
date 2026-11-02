import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Tells a key from a JWT, and makes a leaked key recognisable to a secret scanner. */
export const API_KEY_PREFIX = 'sfk_';

const KEY_ID_BYTES = 12;
const SECRET_BYTES = 32;

/** Hex keeps the identifier clear of the `_` separator, which the base64url secret may contain. */
const KEY_ID_PATTERN = new RegExp(`^[0-9a-f]{${KEY_ID_BYTES * 2}}$`);

const SEPARATOR_INDEX = API_KEY_PREFIX.length + KEY_ID_BYTES * 2;

export interface IIssuedToken {
  keyId: string;
  secretHash: string;

  token: string;
}

export interface IPresentedToken {
  keyId: string;
  secret: string;
}

@Injectable()
export class ApiKeyTokenService {
  issue(): IIssuedToken {
    const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');

    return {
      keyId,
      secretHash: this.hash(secret),
      token: `${API_KEY_PREFIX}${keyId}_${secret}`,
    };
  }

  parse(token: string): IPresentedToken | null {
    if (!token.startsWith(API_KEY_PREFIX) || token[SEPARATOR_INDEX] !== '_') {
      return null;
    }

    const keyId = token.slice(API_KEY_PREFIX.length, SEPARATOR_INDEX);
    const secret = token.slice(SEPARATOR_INDEX + 1);

    if (!KEY_ID_PATTERN.test(keyId) || secret.length === 0) {
      return null;
    }

    return { keyId, secret };
  }

  matches(secret: string, secretHash: string): boolean {
    const presented = Buffer.from(this.hash(secret), 'hex');
    const stored = Buffer.from(secretHash, 'hex');

    if (presented.length !== stored.length) {
      return false;
    }

    return timingSafeEqual(presented, stored);
  }

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}
