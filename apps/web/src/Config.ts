export class Config {
  public static readonly APP_NAME = 'Swarmfoundry';

  public static readonly VERSION =
    typeof import.meta.env.VITE_APP_VERSION === 'string' ? import.meta.env.VITE_APP_VERSION : 'dev';

  // The AGPL asks a network service to offer its users the source it runs.
  public static readonly SOURCE_URL = 'https://github.com/lcollins-dev/swarmfoundry';

  public static readonly API_BASE_URL = '/api/v1/';
  public static readonly API_TIMEOUT_MS = 15000;

  public static readonly LIST_DEBOUNCE_MS = 400;
}
