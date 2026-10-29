import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from './config.service';

describe('ConfigService', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_APP_BASE_URL', 'http://localhost:8080');
    vi.stubEnv('TYPEORM_HOST', 'localhost');
    vi.stubEnv('EMAIL_FROM_ADDRESS', 'no-reply@app.test');
    vi.stubEnv('USER_TOKEN_SECRET', 'token-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('trustProxy', () => {
    const trustProxy = (setting: string | undefined): number | string => {
      vi.stubEnv('TRUST_PROXY', setting);

      return new ConfigService().trustProxy;
    };

    it('reads an all-digit setting as a hop count', () => {
      expect(trustProxy('2')).toBe(2);
    });

    it('reads 0 as trusting no hop', () => {
      expect(trustProxy('0')).toBe(0);
    });

    it('trims the setting before reading it', () => {
      expect(trustProxy(' 1 ')).toBe(1);
    });

    it('passes a list of addresses and preset names on as a string', () => {
      expect(trustProxy('loopback, 192.0.2.0/24')).toBe('loopback, 192.0.2.0/24');
    });

    it('trusts loopback and the private ranges by default', () => {
      expect(trustProxy(undefined)).toBe('loopback, linklocal, uniquelocal');
    });
  });

  describe('config repo', () => {
    beforeEach(() => {
      vi.stubEnv('SWARMFOUNDRY_CONFIG_REPO', 'https://gitlab.test/ops/config.git');
      vi.stubEnv('SWARMFOUNDRY_CONFIG_BRANCH', 'main');
    });

    it('reads the repo, the branch and the poll interval in milliseconds', () => {
      const config = new ConfigService();

      expect(config.configRepo).toBe('https://gitlab.test/ops/config.git');
      expect(config.configBranch).toBe('main');
      expect(config.configPath).toBe('');
      expect(config.configPollIntervalMs).toBe(60_000);
    });

    it('has no repo when the setting is blank', () => {
      vi.stubEnv('SWARMFOUNDRY_CONFIG_REPO', '');
      vi.stubEnv('SWARMFOUNDRY_CONFIG_BRANCH', '');

      expect(new ConfigService().configRepo).toBeUndefined();
    });

    it('requires a branch with the repo', () => {
      vi.stubEnv('SWARMFOUNDRY_CONFIG_BRANCH', '');

      expect(() => new ConfigService()).toThrow(/SWARMFOUNDRY_CONFIG_BRANCH: must be set/);
    });

    it('refuses a repo URL holding credentials, or not over http', () => {
      for (const url of ['https://bot:secret@gitlab.test/ops/config.git', 'ssh://gitlab.test/ops/config.git']) {
        vi.stubEnv('SWARMFOUNDRY_CONFIG_REPO', url);

        expect(() => new ConfigService()).toThrow(/SWARMFOUNDRY_CONFIG_REPO/);
      }
    });

    it('refuses a branch git would read as an option', () => {
      vi.stubEnv('SWARMFOUNDRY_CONFIG_BRANCH', '--upload-pack=touch');

      expect(() => new ConfigService()).toThrow(/SWARMFOUNDRY_CONFIG_BRANCH/);
    });

    it('refuses a config path outside the repo', () => {
      for (const path of ['/etc', '../config', 'config/../../etc']) {
        vi.stubEnv('SWARMFOUNDRY_CONFIG_PATH', path);

        expect(() => new ConfigService()).toThrow(/SWARMFOUNDRY_CONFIG_PATH/);
      }
    });

    it('masks the token in the loggable settings', () => {
      vi.stubEnv('SWARMFOUNDRY_CONFIG_TOKEN', 'glpat-config-secret');

      expect(JSON.stringify(new ConfigService().loggable)).not.toContain('glpat-config-secret');
    });
  });

  describe('userIdleTimeout', () => {
    it('defaults to an hour', () => {
      vi.stubEnv('USER_IDLE_TIMEOUT', undefined);

      expect(new ConfigService().userIdleTimeout).toBe('1h');
    });

    it('accepts 0 and a span with a unit', () => {
      for (const setting of ['0', '30m', '12 hours']) {
        vi.stubEnv('USER_IDLE_TIMEOUT', setting);

        expect(new ConfigService().userIdleTimeout).toBe(setting);
      }
    });

    it('refuses a number without a unit, which ms would read as milliseconds', () => {
      vi.stubEnv('USER_IDLE_TIMEOUT', '30');

      expect(() => new ConfigService()).toThrow(/USER_IDLE_TIMEOUT: must be a duration with a unit/);
    });
  });
});
