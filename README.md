# @fikaro/client

Official JavaScript and TypeScript client for [Fikaro](https://fikaro.ir) — an Iranian backend-as-a-service.

Define your data model in a visual panel and Fikaro gives you a real REST API, a dedicated PostgreSQL database, end-user authentication and generated docs. This package is how your app talks to it.

- **Zero dependencies.** Works in browsers, Node 18+, Deno, Bun, React Native and any Edge runtime with `fetch`.
- **Typed end to end**, including the error shape.
- **17 kB of JavaScript, 5.5 kB gzipped** — before your bundler minifies it. No bundled HTTP client, no polyfills.

```bash
npm install @fikaro/client
```

## Quick start

```ts
import { createClient } from "@fikaro/client";

const client = createClient({
  project: "my-app",         // the {slug} in https://api.fikaro.ir/{slug}/v1
  key: "apck_pub_...",       // publishable key — safe to ship in a client app
});

const { data } = await client.from("product").list({
  filter: { status: "active", price: { gt: 50 } },
  sort: "-createdAt",
  limit: 20,
});
```

## Reading and writing

`from()` returns a handle on one entity in your schema. Pass a type parameter to get typed results — the schema is dynamic on the server, so the SDK cannot infer it for you.

```ts
interface Product {
  id: string;
  name: string;
  price: number;
  status: "active" | "archived";
}

const products = client.from<Product>("product");

const { data, pagination } = await products.list({ limit: 20 });
const one     = await products.get("019fd28e-674e-71ba-a99f-b4c1ec3b4a97");
const created = await products.create({ name: "قهوه", price: 120000 });
const updated = await products.update(created.id, { price: 130000 });
await products.delete(created.id);

await products.createMany([{ name: "A" }, { name: "B" }]);
const items = await client.from("order").related("order-id", "items");
```

### Filtering

Conditions are combined with AND. A bare value means equality.

```ts
await products.list({
  filter: {
    status: "active",              // filter[status]=active
    price:  { gte: 50, lt: 500 },  // filter[price][gte]=50&filter[price][lt]=500
    name:   { like: "%قهوه%" },
  },
});
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `in`.

### Pagination

Pagination is cursor-based rather than page numbers, so inserts during a listing cannot make a page repeat or skip records.

```ts
let cursor: string | undefined;
do {
  const page = await products.list({ limit: 100, cursor });
  handle(page.data);
  cursor = page.pagination.nextCursor ?? undefined;
} while (cursor);
```

Or let the SDK follow the cursors. It is an async generator, so `break` stops fetching instead of loading a whole table into memory:

```ts
for await (const product of products.listAll({ limit: 100 })) {
  if (product.price > 1_000_000) break;
}
```

## Authenticating your users

These are the people who use *your* app, not your Fikaro account. Once someone signs in, every request carries their identity, so project access rules — including `scope=own`, which limits a user to their own records — apply automatically.

```ts
await client.auth.signup("user@example.com", "correct horse battery staple");
const session = await client.auth.login("user@example.com", "correct horse battery staple");

client.auth.isAuthenticated;  // boolean, expiry-aware
client.auth.session;          // { user, accessToken, refreshToken, expiresAt }

const me = await client.auth.me();
await client.auth.changePassword("old", "new");
await client.auth.requestPasswordReset("user@example.com");
await client.auth.logout();
```

Expired access tokens are refreshed automatically: a 401 triggers one refresh and the original request is replayed. Concurrent requests share a single refresh, because refresh tokens rotate and a second parallel attempt would fail.

### Where the session is stored

In memory by default — it dies with the page. That is deliberate. Persisting tokens is a security decision with real consequences, so it is opt-in:

```ts
import { createClient, browserStorage } from "@fikaro/client";

const client = createClient({
  project: "my-app",
  storage: browserStorage(),   // localStorage: survives reloads
});
```

`localStorage` is readable by any script on your page, so one XSS is one stolen refresh token. Fine for a low-risk app; wrong for anything holding payments or personal records. Implement `TokenStorage` yourself for anything else — an httpOnly cookie via your own server, `expo-secure-store`, the OS keychain.

## Errors

Failures arrive as `FikaroError`, carrying the server's RFC 7807 problem details. Branch on `code` or the status helpers — never on message text, which is localised (Persian by default).

```ts
import { FikaroError, FikaroNetworkError } from "@fikaro/client";

try {
  await products.create({ price: -1 });
} catch (err) {
  if (err instanceof FikaroError) {
    err.status;                  // 422
    err.code;                    // "validation_failed"
    err.fieldError("price");     // message for one field, if any
    err.isUnauthorized;          // 401 — token missing or expired
    err.isForbidden;             // 403 — authenticated but not allowed
    err.isRateLimited;           // 429 — check Retry-After
  } else if (err instanceof FikaroNetworkError) {
    // Never reached the API: offline, DNS, timeout. Safe to retry.
  }
}
```

## API keys

| Prefix | Where it belongs |
| --- | --- |
| `apck_pub_` | Publishable. Read-only, limited to entities you explicitly made public. Safe in a browser bundle or a mobile binary. |
| `apck_prod_`, `apck_play_` | Secret. Server-side only. Anything shipped to a device is public, whatever the bundler does. |

## Configuration

```ts
createClient({
  project: "my-app",             // required
  key: "apck_pub_...",           // optional when every request is user-authenticated
  baseUrl: "https://api.fikaro.ir",
  storage: browserStorage(),
  timeout: 30_000,
  fetch: customFetch,            // for tests or exotic runtimes
});
```

For anything the SDK does not wrap yet:

```ts
await client.request("POST", "/some/endpoint", { any: "body" });
```

## Runtime support

Node 18+, all current browsers, Deno, Bun, Cloudflare Workers, React Native. The only requirement is a global `fetch`; pass your own via `fetch` if your runtime lacks one.

## Links

- [fikaro.ir](https://fikaro.ir) — the product
- [Documentation](https://fikaro.ir/docs) (Persian)
- [Blog](https://fikaro.ir/blog) (Persian)
- Support: support@fikaro.ir

## License

MIT
