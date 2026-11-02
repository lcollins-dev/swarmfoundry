import { AppError, ValidationError } from '../error';

export enum ApiErrorType {
  VALIDATION = 'VALIDATION',
  BAD_REQUEST = 'BAD_REQUEST',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  TIMEOUT = 'TIMEOUT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  NETWORK = 'NETWORK',
  UNKNOWN = 'UNKNOWN',
}

export class ApiErrorBase {
  private constructor(
    public type: ApiErrorType,
    public message: string
  ) {}

  public static readonly BAD_REQUEST = new ApiErrorBase(ApiErrorType.BAD_REQUEST, 'The request was not valid.');

  public static readonly TOO_MANY_REQUESTS = new ApiErrorBase(
    ApiErrorType.TOO_MANY_REQUESTS,
    'Too many requests. Wait a moment and try again.'
  );

  public static readonly TIMEOUT = new ApiErrorBase(ApiErrorType.TIMEOUT, 'The request timed out. Please try again.');

  public static readonly UNAUTHORIZED = new ApiErrorBase(
    ApiErrorType.UNAUTHORIZED,
    'Your session has ended. Sign in again to continue.'
  );

  public static readonly FORBIDDEN = new ApiErrorBase(ApiErrorType.FORBIDDEN, "You don't have permission to do this.");

  public static readonly NOT_FOUND = new ApiErrorBase(
    ApiErrorType.NOT_FOUND,
    'The requested item could not be found. It may have been removed.'
  );

  public static readonly NETWORK = new ApiErrorBase(
    ApiErrorType.NETWORK,
    'Could not connect to the server. Check your connection and try again.'
  );

  public static readonly UNKNOWN = new ApiErrorBase(ApiErrorType.UNKNOWN, 'The request failed. Please try again.');
}

export class ApiError extends AppError {
  public type: ApiErrorType;
  public message: string;

  constructor(apiErrorBase: ApiErrorBase, message?: string) {
    const type = apiErrorBase.type;
    const newMessage = message ?? apiErrorBase.message;

    super(`${type}: ${newMessage}`);

    this.type = type;
    this.message = newMessage;
  }

  /** Asking again gets the same answer, as for a task that doesn't exist. */
  get refused(): boolean {
    return (
      this.type === ApiErrorType.BAD_REQUEST ||
      this.type === ApiErrorType.FORBIDDEN ||
      this.type === ApiErrorType.NOT_FOUND
    );
  }
}

export class ApiValidationError extends ValidationError {}
