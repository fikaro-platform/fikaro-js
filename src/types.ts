/** Filter operators the API accepts. Anything else is rejected server-side. */
export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "in";

/**
 * A filter value. `{ gt: 50 }` becomes `filter[price][gt]=50`; a bare value
 * becomes `filter[price]=50`, which the server reads as `eq`.
 */
export type FilterValue =
  | string
  | number
  | boolean
  | null
  | Partial<Record<FilterOperator, unknown>>;

export interface ListOptions {
  /** `{ price: { gt: 50 }, status: "active" }` — conditions are ANDed. */
  filter?: Record<string, FilterValue>;
  /** `"-createdAt"` for descending, `"name"` for ascending. */
  sort?: string;
  /** Server clamps this to its own maximum. */
  limit?: number;
  /** Opaque cursor from the previous page's `pagination.nextCursor`. */
  cursor?: string;
  /** Relations to embed, e.g. `["category"]`. */
  include?: string[];
}

/**
 * Pagination is cursor-based, not page numbers: an offset shifts when rows are
 * inserted mid-listing, so page 2 can repeat or skip records. `nextCursor` is
 * null on the last page.
 */
export interface Pagination {
  limit: number;
  nextCursor: string | null;
}

export interface ListResult<T> {
  data: T[];
  pagination: Pagination;
}

/** A record's shape is defined by your project schema, so it stays open. */
export type Entity = Record<string, unknown>;

export interface TenantUser {
  id: string;
  email?: string;
  mobile?: string;
  role?: string;
  [key: string]: unknown;
}

export interface AuthSession {
  user: TenantUser;
  accessToken: string;
  refreshToken: string;
  /** RFC 3339 timestamp, UTC. */
  expiresAt: string;
  /** Set when an admin forced a reset; send the user to a change-password UI. */
  mustChangePassword?: boolean;
}

/**
 * Where the session lives between page loads.
 *
 * The default is in-memory, which is the safe default rather than the
 * convenient one: `localStorage` is readable by any script on the page, so a
 * single XSS turns into a stolen refresh token. Pass a storage explicitly if
 * you accept that trade — the decision should be visible in your code, not
 * inherited from a library.
 */
export interface TokenStorage {
  get(): AuthSession | null;
  set(session: AuthSession | null): void;
}

export interface ClientOptions {
  /** Your project slug — the `{slug}` in `https://api.fikaro.ir/{slug}/v1`. */
  project: string;
  /**
   * An API key. Use a publishable key (`apck_pub_`) in anything a user can
   * read — a browser bundle, a mobile binary. Secret keys belong on a server.
   */
  key?: string;
  /** Override for self-hosted or staging deployments. */
  baseUrl?: string;
  /** Defaults to in-memory; see TokenStorage. */
  storage?: TokenStorage;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Injected for tests or for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
}
