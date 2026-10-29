export interface ISignInCredentials {
  email: string;
  password: string;
}

// Seeded admin, created by the test migration apps/api/src/database/migrations/test/9000000000000-TestData.ts.
export const TEST_USER: ISignInCredentials = {
  email: 'admin@swarmfoundry.test',
  password: 'TestPass123!',
};

// Password given to users built by the user factory.
export const TEST_PASSWORD = 'TestPass123!';
