/**
 * Typed application errors. Every one carries an HTTP status and a stable
 * machine-readable `code`, so clients can branch on `code` rather than parsing
 * human-facing messages.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'authentication required') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'you do not have access to this resource') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'resource not found') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'conflict', details?: unknown) {
    super(409, code, message, details);
  }
}

/**
 * Overdraft. 422 rather than 400: the request was well-formed and the client
 * had no way to know it would fail -- the balance may have changed between
 * their read and their write.
 */
export class InsufficientFundsError extends AppError {
  constructor(details: { walletId: string; balance: string; requested: string }) {
    super(
      422,
      'insufficient_funds',
      'wallet has insufficient funds for this transfer',
      details,
    );
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'too_many_requests', 'too many requests', { retryAfterSeconds });
  }
}
