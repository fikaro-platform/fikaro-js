import { toSession, type Transport } from "./http.js";
import type { AuthSession, TenantUser, TokenStorage } from "./types.js";

/**
 * End-user authentication — the people who use YOUR app, not your Fikaro
 * account.
 *
 * Signing in stores the session and every later request carries it, so the
 * project's access rules (including `scope=own`, which limits a user to their
 * own records) apply automatically.
 */
export class Auth {
  constructor(
    private transport: Transport,
    private storage: TokenStorage,
    private onSession: (s: AuthSession | null) => void,
  ) {}

  /** The stored session, or null. Does not hit the network. */
  get session(): AuthSession | null {
    return this.storage.get();
  }

  /**
   * Whether a session exists and has not expired.
   *
   * A 30-second skew is subtracted so a token that expires mid-flight is
   * treated as already gone — otherwise a request sent at T-1s arrives after
   * expiry and comes back 401.
   */
  get isAuthenticated(): boolean {
    const s = this.storage.get();
    if (!s?.accessToken) return false;
    const expiry = Date.parse(s.expiresAt);
    return Number.isNaN(expiry) ? true : expiry - 30_000 > Date.now();
  }

  private async store(raw: Record<string, unknown>): Promise<AuthSession> {
    const session = toSession(raw);
    this.onSession(session);
    return session;
  }

  async signup(email: string, password: string): Promise<AuthSession> {
    return this.store(
      await this.transport.request<Record<string, unknown>>("POST", "/auth/signup", {
        body: { email, password },
        auth: false,
      }),
    );
  }

  async login(email: string, password: string): Promise<AuthSession> {
    return this.store(
      await this.transport.request<Record<string, unknown>>("POST", "/auth/login", {
        body: { email, password },
        auth: false,
      }),
    );
  }

  /** Usually unnecessary — the SDK refreshes on its own after a 401. */
  async refresh(): Promise<AuthSession> {
    const current = this.storage.get();
    if (!current?.refreshToken) throw new Error("No refresh token in storage");
    return this.store(
      await this.transport.request<Record<string, unknown>>("POST", "/auth/refresh", {
        body: { refresh_token: current.refreshToken },
        auth: false,
      }),
    );
  }

  /** The signed-in user, straight from the server. */
  me(): Promise<TenantUser> {
    return this.transport.request<TenantUser>("GET", "/auth/me");
  }

  /**
   * Ends the session. Local state is cleared even if the server call fails —
   * a network error must not leave someone looking signed in on a device they
   * just signed out of.
   */
  async logout(): Promise<void> {
    try {
      await this.transport.request<void>("POST", "/auth/logout", { body: {} });
    } finally {
      this.onSession(null);
    }
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.transport.request<void>("POST", "/auth/password", {
      body: { current_password: currentPassword, new_password: newPassword },
    });
  }

  /**
   * Starts a password reset. Always resolves, whether or not the address is
   * registered — the server refuses to reveal which, and so does this.
   */
  requestPasswordReset(email: string): Promise<void> {
    // /auth/password/forgot sends the link; /auth/password/reset is the step
    // after it (resetPassword below). 0.1.0 posted here to the wrong one.
    return this.transport.request<void>("POST", "/auth/password/forgot", {
      body: { email },
      auth: false,
    });
  }

  /**
   * Finishes a reset: the token from the emailed link, and the new password.
   * The user is not signed in by this — call login() with the new password.
   */
  resetPassword(token: string, newPassword: string): Promise<void> {
    return this.transport.request<void>("POST", "/auth/password/reset", {
      body: { token, new_password: newPassword },
      auth: false,
    });
  }
}
