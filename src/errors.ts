/**
 * The API answers failures with RFC 7807 Problem Details, plus a stable
 * machine-readable `code` and an optional field-level `errors` array.
 *
 * The SDK surfaces that shape instead of flattening it to a string, because
 * the two useful things — "which rule failed" and "which field" — are exactly
 * what gets lost when an error becomes `new Error(message)`.
 *
 * `title` and `detail` are localised by the server from `Accept-Language`
 * (Persian by default), so they are for humans. Branch on `code`, never on
 * message text.
 */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  errors?: FieldError[];
}

export class FikaroError extends Error {
  readonly status: number;
  /** Stable identifier — branch on this, not on `message`. */
  readonly code: string;
  readonly detail: string;
  readonly instance?: string;
  /** Field-level validation failures, when the server sent them. */
  readonly errors: FieldError[];

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || `HTTP ${problem.status}`);
    this.name = "FikaroError";
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.errors = problem.errors ?? [];
  }

  /** The access token is missing, malformed or expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Authenticated, but not allowed to touch this record. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Per-second rate limit or the monthly quota. Check `Retry-After`. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Convenience for form UIs: the message for one field, if any. */
  fieldError(field: string): string | undefined {
    return this.errors.find((e) => e.field === field)?.message;
  }
}

/**
 * Thrown when the request never reached the API — offline, DNS failure,
 * timeout. Kept distinct from FikaroError so callers can retry transport
 * failures without retrying a 400.
 */
export class FikaroNetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FikaroNetworkError";
    this.cause = cause;
  }
}
