/** Names the method, status and path only, so it never carries the token or a response body. */
export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string
  ) {
    super(`GitLab answered ${status} to ${method} ${path}`);
    this.name = GitLabApiError.name;
  }
}

export class GitLabUnknownUserError extends Error {
  constructor(username: string) {
    super(`GitLab has no user ${username}`);
    this.name = GitLabUnknownUserError.name;
  }
}

/** Unredacted: pass it through `redact()` before it reaches a log. */
export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
