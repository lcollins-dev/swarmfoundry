# End-to-end tests

Playwright tests for `apps/web`.

## Prerequisites

1. Start the stack from the repository root: `npm run instance:start`.
2. Install browsers once: `npm run -w e2e install-browsers`.

## Running

```sh
npm run test:e2e             # from the repo root
npm run -w e2e test:e2e      # headless
npm run -w e2e test:ui       # UI mode
npm run -w e2e test:headed   # show the browser
npm run -w e2e report        # open the HTML report
```

Tests use the URL for this checkout's dev instance. Set `E2E_BASE_URL` to test another environment:

```sh
E2E_BASE_URL=https://test.example.com npm run -w e2e test:e2e
```

Run a subset:

```sh
npm run -w e2e test:e2e -- --project=chromium
npm run -w e2e test:e2e -- -g "signs in"
npm run -w e2e test:e2e -- tests/navigation.spec.ts
```

## Test data

Tests use the admin created by `apps/api/src/database/migrations/test/9000000000000-TestData.ts`.
For a separate session, create a user through the admin API with `factories/user.factory.ts`. The API allows one
session per user, so signing in as the shared admin again invalidates other tests' tokens.
