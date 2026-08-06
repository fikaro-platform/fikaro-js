import { Auth } from "./auth.js";
import { Collection } from "./collection.js";
import { Transport } from "./http.js";
import type { AuthSession, ClientOptions, Entity, TokenStorage } from "./types.js";

export { FikaroError, FikaroNetworkError } from "./errors.js";
export type { FieldError, ProblemDetails } from "./errors.js";
export { Collection } from "./collection.js";
export { Auth } from "./auth.js";
export type {
  AuthSession,
  ClientOptions,
  Entity,
  FilterOperator,
  FilterValue,
  ListOptions,
  ListResult,
  Pagination,
  TenantUser,
  TokenStorage,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.fikaro.ir";
const DEFAULT_TIMEOUT = 30_000;

/**
 * In-memory session storage — the default.
 *
 * Deliberately forgetful: the session dies with the page. Persisting auth
 * tokens is a security decision with real consequences, so it is opt-in via
 * `storage`, never something the SDK does quietly on your behalf.
 */
function memoryStorage(): TokenStorage {
  let session: AuthSession | null = null;
  return {
    get: () => session,
    set: (s) => {
      session = s;
    },
  };
}

/**
 * Session storage backed by `localStorage`.
 *
 * Survives reloads, and is readable by any script running on your page — so
 * one XSS is one stolen refresh token. Reasonable for a low-risk app, wrong
 * for anything holding payments or personal records. Opt in knowingly:
 *
 * ```ts
 * import { createClient, browserStorage } from "@fikaro/client";
 * const client = createClient({ project: "my-app", storage: browserStorage() });
 * ```
 */
export function browserStorage(key = "fikaro.session"): TokenStorage {
  return {
    get() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as AuthSession) : null;
      } catch {
        return null; // private mode, disabled storage, corrupt value
      }
    },
    set(session) {
      try {
        if (session) globalThis.localStorage?.setItem(key, JSON.stringify(session));
        else globalThis.localStorage?.removeItem(key);
      } catch {
        /* storage unavailable — the session simply stays in memory */
      }
    },
  };
}

export class FikaroClient {
  readonly auth: Auth;
  private transport: Transport;
  private storage: TokenStorage;
  private collections = new Map<string, Collection<Entity>>();

  constructor(options: ClientOptions) {
    if (!options.project) throw new Error("`project` is required");
    this.storage = options.storage ?? memoryStorage();

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "No fetch available. Use Node 18+, or pass one via `fetch` in the options.",
      );
    }

    const onSession = (s: AuthSession | null) => this.storage.set(s);

    this.transport = new Transport({
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      project: options.project,
      key: options.key,
      storage: this.storage,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      fetchImpl: fetchImpl.bind(globalThis),
      onSession,
    });

    this.auth = new Auth(this.transport, this.storage, onSession);
  }

  /**
   * A handle on one entity. Cached, so repeated calls return the same object
   * and `from()` is cheap enough to call inline.
   */
  from<T extends Entity = Entity>(entity: string): Collection<T> {
    let c = this.collections.get(entity);
    if (!c) {
      c = new Collection<Entity>(this.transport, entity);
      this.collections.set(entity, c);
    }
    return c as Collection<T>;
  }

  /** Escape hatch for endpoints the SDK does not wrap yet. */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.transport.request<T>(method, path, { body });
  }
}

export function createClient(options: ClientOptions): FikaroClient {
  return new FikaroClient(options);
}
