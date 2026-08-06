import { FikaroError, FikaroNetworkError, type ProblemDetails } from "./errors.js";
import type { AuthSession, TokenStorage } from "./types.js";

export interface TransportConfig {
  baseUrl: string;
  project: string;
  key?: string;
  storage: TokenStorage;
  timeout: number;
  fetchImpl: typeof globalThis.fetch;
  /** Called when a refresh produces a new session, so the client can persist it. */
  onSession: (session: AuthSession | null) => void;
}

/**
 * The one place that talks to the network.
 *
 * Two behaviours worth knowing about:
 *
 * 1. A 401 on an authenticated request triggers exactly one refresh attempt,
 *    then replays the original request. Concurrent 401s share a single refresh
 *    promise — without that, ten parallel requests after an expiry produce ten
 *    refreshes, and every one but the first fails because refresh tokens
 *    rotate.
 *
 * 2. Errors are never swallowed into a generic Error. The server speaks
 *    RFC 7807; that shape survives all the way to the caller.
 */
export class Transport {
  private refreshing: Promise<AuthSession | null> | null = null;

  constructor(private cfg: TransportConfig) {}

  private url(path: string, query?: URLSearchParams): string {
    const base = `${this.cfg.baseUrl}/${this.cfg.project}/v1${path}`;
    const qs = query?.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private headers(auth: boolean): Headers {
    const h = new Headers({ "Content-Type": "application/json" });
    const session = this.cfg.storage.get();
    // A user token wins over the API key: once someone is signed in, the
    // request should carry their identity so `scope=own` rules apply to them.
    if (auth && session?.accessToken) {
      h.set("Authorization", `Bearer ${session.accessToken}`);
    } else if (this.cfg.key) {
      h.set("Authorization", `Bearer ${this.cfg.key}`);
    }
    return h;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { query?: URLSearchParams; body?: unknown; auth?: boolean; retry?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeout);

    let res: Response;
    try {
      res = await this.cfg.fetchImpl(this.url(path, opts.query), {
        method,
        headers: this.headers(auth),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new FikaroNetworkError(
        controller.signal.aborted
          ? `Request timed out after ${this.cfg.timeout}ms`
          : "Network request failed",
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 && auth && opts.retry !== false && this.cfg.storage.get()?.refreshToken) {
      const session = await this.refreshOnce();
      if (session) {
        // retry:false — one refresh per request, never a loop.
        return this.request<T>(method, path, { ...opts, retry: false });
      }
    }

    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Collapses concurrent refreshes into one in-flight attempt. */
  private refreshOnce(): Promise<AuthSession | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<AuthSession | null> {
    const current = this.cfg.storage.get();
    if (!current?.refreshToken) return null;
    try {
      const raw = await this.request<Record<string, unknown>>(
        "POST",
        "/auth/refresh",
        { body: { refresh_token: current.refreshToken }, auth: false, retry: false },
      );
      const session = toSession(raw);
      this.cfg.onSession(session);
      return session;
    } catch {
      // A failed refresh means the session is gone for good; clearing it stops
      // every later request from paying for another doomed round trip.
      this.cfg.onSession(null);
      return null;
    }
  }
}

/** Maps the server's snake_case auth payload onto the SDK's camelCase shape. */
export function toSession(raw: Record<string, unknown>): AuthSession {
  return {
    user: raw.user as AuthSession["user"],
    accessToken: raw.access_token as string,
    refreshToken: raw.refresh_token as string,
    expiresAt: raw.expires_at as string,
    ...(raw.must_change_password === true ? { mustChangePassword: true } : {}),
  };
}

async function toError(res: Response): Promise<FikaroError> {
  let problem: ProblemDetails;
  try {
    problem = (await res.json()) as ProblemDetails;
  } catch {
    // A proxy or gateway can fail before the API is reached, so a non-JSON
    // body is a real case rather than a defensive branch.
    problem = {
      type: "about:blank",
      title: res.statusText || "Request failed",
      status: res.status,
      detail: res.statusText || `HTTP ${res.status}`,
      code: "http_error",
    };
  }
  if (typeof problem.status !== "number") problem.status = res.status;
  if (!problem.code) problem.code = "http_error";
  return new FikaroError(problem);
}
