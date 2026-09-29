import type { Transport } from "./http.js";
import type { Entity, ListOptions, ListResult } from "./types.js";

/**
 * A typed handle on one entity in your schema.
 *
 * `client.from<Product>("product")` — the type parameter is yours to supply;
 * the server's schema is dynamic, so the SDK cannot infer it. Nothing is
 * validated client-side: the API is the authority, and a second copy of the
 * rules here would be a second thing to keep in sync.
 */
export class Collection<T extends Entity = Entity> {
  constructor(
    private transport: Transport,
    private entity: string,
  ) {}

  /**
   * Turns the options object into the query string the API expects:
   * `filter[price][gt]=50&sort=-createdAt&limit=20`.
   *
   * A bare value means `eq`, matching the server's own default, so
   * `{ status: "active" }` and `{ status: { eq: "active" } }` are the same
   * request.
   */
  private query(opts: ListOptions): URLSearchParams {
    const q = new URLSearchParams();
    for (const [field, value] of Object.entries(opts.filter ?? {})) {
      if (value !== null && typeof value === "object") {
        for (const [op, v] of Object.entries(value)) {
          if (v !== undefined) q.append(`filter[${field}][${op}]`, String(v));
        }
      } else if (value !== undefined) {
        q.append(`filter[${field}]`, String(value));
      }
    }
    if (opts.sort) q.append("sort", opts.sort);
    if (opts.limit !== undefined) q.append("limit", String(opts.limit));
    if (opts.cursor) q.append("cursor", opts.cursor);
    if (opts.include?.length) q.append("include", opts.include.join(","));
    if (opts.search?.trim()) q.append("search", opts.search.trim());
    return q;
  }

  /** One page of records, newest-first unless you pass `sort`. */
  list(opts: ListOptions = {}): Promise<ListResult<T>> {
    return this.transport.request<ListResult<T>>("GET", `/${this.entity}`, {
      query: this.query(opts),
    });
  }

  /**
   * Every record, following cursors until the API says there are no more.
   *
   * An async generator rather than a fat array: a table can outgrow memory,
   * and this lets the caller stop early with `break` without fetching the
   * rest. `maxPages` is a seatbelt against an unbounded loop.
   */
  async *listAll(
    opts: ListOptions = {},
    maxPages = 1000,
  ): AsyncGenerator<T, void, undefined> {
    let cursor = opts.cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.list({ ...opts, cursor });
      for (const row of res.data) yield row;
      if (!res.pagination?.nextCursor) return;
      cursor = res.pagination.nextCursor;
    }
  }

  get(id: string): Promise<T> {
    return this.transport.request<T>("GET", `/${this.entity}/${encodeURIComponent(id)}`);
  }

  create(data: Partial<T>): Promise<T> {
    return this.transport.request<T>("POST", `/${this.entity}`, { body: data });
  }

  update(id: string, data: Partial<T>): Promise<T> {
    return this.transport.request<T>("PATCH", `/${this.entity}/${encodeURIComponent(id)}`, {
      body: data,
    });
  }

  delete(id: string): Promise<void> {
    return this.transport.request<void>("DELETE", `/${this.entity}/${encodeURIComponent(id)}`);
  }

  /** Create many in one round trip. */
  createMany(rows: Partial<T>[]): Promise<{ data: T[] }> {
    return this.transport.request<{ data: T[] }>("POST", `/${this.entity}/bulk`, {
      body: { data: rows },
    });
  }

  /** Records on the other side of a relation, e.g. an order's items. */
  related<R extends Entity = Entity>(
    id: string,
    relation: string,
    opts: ListOptions = {},
  ): Promise<ListResult<R>> {
    return this.transport.request<ListResult<R>>(
      "GET",
      `/${this.entity}/${encodeURIComponent(id)}/${encodeURIComponent(relation)}`,
      { query: this.query(opts) },
    );
  }
}
