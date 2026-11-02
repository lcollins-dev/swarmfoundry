import { type APIRequestContext, expect } from '@playwright/test';

import { adminHeaders } from '../utils/auth';
import { BASE_URL } from '../utils/urls';
import { ISignInCredentials, TEST_PASSWORD } from '../utils/users';

export interface ITestUser extends ISignInCredentials {
  id: number;
  name: string;
}

export interface ICreateTestUserOptions {
  name?: string;
  userRoleIds?: number[];
}

export const uniqueEmail = (label = 'e2e'): string =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@swarmfoundry.test`;

export interface IInvitedTestUser {
  id: number;
  name: string;
  email: string;
  token: string;
}

export const linkToken = (link: string): string => link.split('#')[1];

export const inviteTestUser = async (
  request: APIRequestContext,
  options: ICreateTestUserOptions = {}
): Promise<IInvitedTestUser> => {
  const email = uniqueEmail();
  const name = options.name ?? 'E2E User';

  const response = await request.post(`${BASE_URL}/api/v1/admin/user/invite`, {
    headers: adminHeaders(),
    data: { name, email, userRoleIds: options.userRoleIds ?? [] },
  });

  expect(response.status()).toBe(201);

  const body = (await response.json()) as { userId: number; passwordLink: { link: string } };

  return { id: body.userId, name, email, token: linkToken(body.passwordLink.link) };
};

// Invites a user through the admin api and follows their link, so a spec that signs in gets a session of its own.
export const createTestUser = async (
  request: APIRequestContext,
  options: ICreateTestUserOptions = {}
): Promise<ITestUser> => {
  const invited = await inviteTestUser(request, options);

  const response = await request.post(`${BASE_URL}/api/v1/password-link`, {
    data: { token: invited.token, password: TEST_PASSWORD },
  });

  expect(response.status()).toBe(200);

  return { id: invited.id, name: invited.name, email: invited.email, password: TEST_PASSWORD };
};
