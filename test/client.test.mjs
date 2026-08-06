import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createClient,
  FikaroError,
  FikaroNetworkError,
} from "../dist/index.js";

/**
 * Every test drives the client through an injected fetch, so what is asserted
 * is the exact request that would go over the wire — URL, method, headers,
 * body. That is the part a consumer depends on, and the part a refactor can
 * silently change.
 */
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), ...init });
    return handler(String(url), init, calls.length - 1);
  };
  return { fn, calls };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("builds the tenant URL from project + entity", async () => {
  const { fn, calls } = mockFetch(() => json({ data: [], pagination: { limit: 20, nextCursor: null } }));
  const client = createClient({ project: "my-app", key: "apck_pub_x", fetch: fn });
  await client.from("product").list();
  assert.equal(calls[0].url, "https://api.fikaro.ir/my-app/v1/product");
});

test("encodes filters, operators, sort, limit and include", async () => {
  const { fn, calls } = mockFetch(() => json({ data: [], pagination: { limit: 5, nextCursor: null } }));
  const client = createClient({ project: "shop", fetch: fn });
  await client.from("product").list({
    filter: { status: "active", price: { gt: 50, lte: 200 } },
    sort: "-createdAt",
    limit: 5,
    include: ["category"],
  });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("filter[status]"), "active");
  assert.equal(url.searchParams.get("filter[price][gt]"), "50");
  assert.equal(url.searchParams.get("filter[price][lte]"), "200");
  assert.equal(url.searchParams.get("sort"), "-createdAt");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("include"), "category");
});

test("sends the API key when nobody is signed in", async () => {
  const { fn, calls } = mockFetch(() => json({ data: [], pagination: {} }));
  const client = createClient({ project: "p", key: "apck_pub_abc", fetch: fn });
  await client.from("x").list();
  assert.equal(new Headers(calls[0].headers).get("Authorization"), "Bearer apck_pub_abc");
});

test("a signed-in user's token outranks the API key", async () => {
  const { fn, calls } = mockFetch((url) =>
    url.endsWith("/auth/login")
      ? json({ user: { id: "u1" }, access_token: "user-tok", refresh_token: "r1", expires_at: "2030-01-01T00:00:00Z" })
      : json({ data: [], pagination: {} }),
  );
  const client = createClient({ project: "p", key: "apck_pub_abc", fetch: fn });
  await client.auth.login("a@b.co", "pw");
  await client.from("x").list();
  assert.equal(new Headers(calls[1].headers).get("Authorization"), "Bearer user-tok");
});

test("maps the snake_case auth payload to a camelCase session", async () => {
  const { fn } = mockFetch(() =>
    json({
      user: { id: "u1", email: "a@b.co" },
      access_token: "at",
      refresh_token: "rt",
      expires_at: "2030-01-01T00:00:00Z",
      must_change_password: true,
    }),
  );
  const client = createClient({ project: "p", fetch: fn });
  const s = await client.auth.login("a@b.co", "pw");
  assert.equal(s.accessToken, "at");
  assert.equal(s.refreshToken, "rt");
  assert.equal(s.mustChangePassword, true);
  assert.equal(client.auth.isAuthenticated, true);
});

test("an expired session is not treated as authenticated", async () => {
  const { fn } = mockFetch(() =>
    json({ user: { id: "u" }, access_token: "at", refresh_token: "rt", expires_at: "2000-01-01T00:00:00Z" }),
  );
  const client = createClient({ project: "p", fetch: fn });
  await client.auth.login("a@b.co", "pw");
  assert.equal(client.auth.isAuthenticated, false);
});

test("refreshes once on 401 and replays the request", async () => {
  let listCalls = 0;
  const { fn, calls } = mockFetch((url, init) => {
    if (url.endsWith("/auth/login")) {
      return json({ user: { id: "u" }, access_token: "old", refresh_token: "r1", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.endsWith("/auth/refresh")) {
      return json({ user: { id: "u" }, access_token: "new", refresh_token: "r2", expires_at: "2030-01-01T00:00:00Z" });
    }
    listCalls++;
    const token = new Headers(init.headers).get("Authorization");
    return token === "Bearer old"
      ? json({ type: "", title: "", status: 401, detail: "expired", code: "token_expired" }, 401)
      : json({ data: [{ id: "1" }], pagination: { limit: 20, nextCursor: null } });
  });

  const client = createClient({ project: "p", fetch: fn });
  await client.auth.login("a@b.co", "pw");
  const res = await client.from("x").list();

  assert.equal(res.data.length, 1);
  assert.equal(listCalls, 2, "should retry exactly once");
  assert.ok(calls.some((c) => c.url.endsWith("/auth/refresh")));
  assert.equal(client.auth.session.accessToken, "new");
});

test("concurrent 401s share a single refresh", async () => {
  let refreshes = 0;
  const { fn } = mockFetch((url, init) => {
    if (url.endsWith("/auth/login")) {
      return json({ user: { id: "u" }, access_token: "old", refresh_token: "r1", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.endsWith("/auth/refresh")) {
      refreshes++;
      return json({ user: { id: "u" }, access_token: "new", refresh_token: "r2", expires_at: "2030-01-01T00:00:00Z" });
    }
    return new Headers(init.headers).get("Authorization") === "Bearer old"
      ? json({ status: 401, code: "token_expired", type: "", title: "", detail: "" }, 401)
      : json({ data: [], pagination: {} });
  });

  const client = createClient({ project: "p", fetch: fn });
  await client.auth.login("a@b.co", "pw");
  await Promise.all([
    client.from("a").list(),
    client.from("b").list(),
    client.from("c").list(),
  ]);
  // Refresh tokens rotate, so a second concurrent refresh would fail.
  assert.equal(refreshes, 1);
});

test("surfaces RFC 7807 details instead of a flat Error", async () => {
  const { fn } = mockFetch(() =>
    json(
      {
        type: "https://fikaro.ir/errors/validation",
        title: "خطای اعتبارسنجی",
        status: 422,
        detail: "قیمت باید عددی مثبت باشد",
        code: "validation_failed",
        errors: [{ field: "price", code: "min", message: "باید بزرگ‌تر از صفر باشد" }],
      },
      422,
    ),
  );
  const client = createClient({ project: "p", fetch: fn });
  await assert.rejects(
    () => client.from("product").create({ price: -1 }),
    (err) => {
      assert.ok(err instanceof FikaroError);
      assert.equal(err.status, 422);
      assert.equal(err.code, "validation_failed");
      assert.equal(err.fieldError("price"), "باید بزرگ‌تر از صفر باشد");
      return true;
    },
  );
});

test("classifies status codes without string matching", async () => {
  for (const [status, prop] of [
    [401, "isUnauthorized"],
    [403, "isForbidden"],
    [404, "isNotFound"],
    [429, "isRateLimited"],
  ]) {
    const { fn } = mockFetch(() => json({ status, code: "x", type: "", title: "", detail: "" }, status));
    const client = createClient({ project: "p", fetch: fn });
    await assert.rejects(
      () => client.from("x").get("1"),
      (err) => err[prop] === true,
    );
  }
});

test("a non-JSON gateway error still becomes a FikaroError", async () => {
  const { fn } = mockFetch(() => new Response("<html>502</html>", { status: 502 }));
  const client = createClient({ project: "p", fetch: fn });
  await assert.rejects(
    () => client.from("x").list(),
    (err) => err instanceof FikaroError && err.status === 502,
  );
});

test("transport failures are a distinct error type", async () => {
  const { fn } = mockFetch(() => {
    throw new TypeError("offline");
  });
  const client = createClient({ project: "p", fetch: fn });
  await assert.rejects(
    () => client.from("x").list(),
    (err) => err instanceof FikaroNetworkError,
  );
});

test("listAll follows cursors and stops at the end", async () => {
  const pages = {
    null: { data: [{ id: "1" }, { id: "2" }], pagination: { limit: 2, nextCursor: "c1" } },
    c1: { data: [{ id: "3" }], pagination: { limit: 2, nextCursor: null } },
  };
  const { fn } = mockFetch((url) => json(pages[new URL(url).searchParams.get("cursor") ?? "null"]));
  const client = createClient({ project: "p", fetch: fn });
  const ids = [];
  for await (const row of client.from("x").listAll({ limit: 2 })) ids.push(row.id);
  assert.deepEqual(ids, ["1", "2", "3"]);
});

test("logout clears the session even when the server call fails", async () => {
  const { fn } = mockFetch((url) => {
    if (url.endsWith("/auth/login")) {
      return json({ user: { id: "u" }, access_token: "at", refresh_token: "rt", expires_at: "2030-01-01T00:00:00Z" });
    }
    throw new TypeError("offline");
  });
  const client = createClient({ project: "p", fetch: fn });
  await client.auth.login("a@b.co", "pw");
  await assert.rejects(() => client.auth.logout());
  assert.equal(client.auth.session, null, "local session must be gone regardless");
});

test("ids are URL-encoded", async () => {
  const { fn, calls } = mockFetch(() => json({ id: "a/b" }));
  const client = createClient({ project: "p", fetch: fn });
  await client.from("x").get("a/b");
  assert.ok(calls[0].url.endsWith("/x/a%2Fb"));
});

test("project is required", () => {
  assert.throws(() => createClient({ project: "" }), /project/);
});
