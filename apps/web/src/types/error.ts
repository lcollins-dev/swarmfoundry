export interface IErrorResponse {
  statusCode: number;
  message: string;
  error?: string;
}

export interface IValidationResponse {
  statusCode: number;
  message: string;
  error?: string;
}

export class AppError extends Error {}

export class ValidationError extends AppError {
  constructor(
    public form: string | null,
    public fields: { [key: string]: { name?: string; message: string } | undefined }
  ) {
    super('Check the highlighted fields and try again.');
  }
}
