# @pmwdigital/idempotency

Idempotency keys for payment and refund handlers. The first request with a key
calls your payment provider and stores the response in Postgres. A retry with the
same key and the same request gets the stored response back, and the provider is
not called a second time.

One TypeScript file with no runtime dependencies. It uses only Web APIs that Deno
(including Supabase Edge Functions) and Node 20+ provide: `crypto.subtle`,
`TextEncoder` and `Response`.

## Why

A charge request times out on the network, the client retries, and the customer
pays twice. Someone double-clicks the refund button and the refund goes out twice.
A unique constraint on the provider's transaction id does not stop this, because
that id only exists after the provider call.

This module claims the key in a table before the provider is called. Only one
request can claim a key, so only one request reaches the provider.

## Install

```bash
npm install github:pmwdigital/pmw-idempotency
```

Then run `sql/payment_idempotency.sql` once on your database (see SQL setup below).

In Deno, for example in a Supabase Edge Function, you can also copy `src/index.ts`
into your functions folder. It has no imports.

## Usage

Wrap the provider call in `withIdempotency`. `run` calls the provider and returns a
`Response`.

```ts
import { createClient } from "@supabase/supabase-js";
import { withIdempotency, type IdempotencyClient } from "@pmwdigital/idempotency";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const store = supabase as unknown as IdempotencyClient;

const response = await withIdempotency(
    store,
    {
        key: body.idempotencyKey,
        kind: "refund",
        callerId: user.id,
        request: { provider: "acme", transactionId: body.transactionId, amount: body.amount },
    },
    corsHeaders,
    () => refundAtProvider(body),
);
```

- `key` comes from the client. The client makes one key per attempt, for example
  with `crypto.randomUUID()` or from the id of the refund row, and sends the same
  key on every retry of that attempt.
- `kind` is `"payment"` or `"refund"`. Keys are scoped by kind, so the same key
  used for a payment and for a refund gives two separate entries.
- `callerId` is stored with the entry and included in the warning for an
  unprotected call. It does not scope the key (see Limits).
- `request` holds the fields that make two requests the same one: provider,
  amount, currency, transaction or order id.
- `corsHeaders` (any `Record<string, string>`) are added to the responses the
  module builds itself.

Use a client created with the service role key. The table grants nothing to other
roles, and a client that cannot write to it runs every call unprotected (see
Limits).

The cast is needed because TypeScript cannot compare the supabase-js types with
`IdempotencyClient` (error TS2589, type instantiation is excessively deep, seen
with supabase-js 2.119 and TypeScript 5.9). At runtime the supabase-js query
builder has every method the module calls.

## What happens

| Situation | Result |
| --- | --- |
| First request with a key | Key claimed as `in_flight`, `run` called, status and body stored |
| Same key and request, first one finished | Stored status and body returned, `run` not called |
| Same key and request, first one still running | 409, `run` not called |
| Same key, different request | 409, `run` not called |
| `run` throws, or answers with status 500 or higher | Claim deleted, error or response passed on, a retry calls `run` again |
| `run` answers below 500 (success, decline, validation error) | Stored, and replayed for later requests |
| Missing or malformed key | `run` called without protection, `console.warn` |

Every 409 has the body `{ "success": false, "errorMessage": "..." }`. Replays and
409 answers carry the headers you pass plus `Content-Type: application/json`. The
first response keeps the handler's own status, headers and body.

## Keys

`isValidIdempotencyKey` accepts 8 to 128 characters of letters, digits, `:`, `_`
and `-`. A UUID passes. A key that fails the check is treated like a missing key:
the call runs unprotected, with a warning. This keeps older clients working. If
every client sends a key, reject requests without one before calling
`withIdempotency`.

## Request hash

`requestHash` sorts the fields by name, writes numbers with two decimals and every
other value with `String()`, and hashes the result with SHA-256. Field order does
not matter, and `10` equals `10.0`. Keep `request` flat:

- Numbers are compared to two decimals, so `10.001` and `10` count as the same
  request. Use integer minor units (cents) if you need more precision.
- `null`, `undefined` and `""` count as the same value.
- Nested objects all become `"[object Object]"`, so their contents are not
  compared. Put the fields that matter at the top level.

## Guarantees

These hold while the table is reachable and the key is valid:

- One request at a time holds a key, until its claim expires (see Limits). The
  claim is an insert on the primary key.
  A second insert fails with a unique violation (23505), and that request does not
  call `run`.
- A finished entry is replayed, not run again. Once a request finished with a
  status below 500, later requests with the same key and request get the stored
  answer, for as long as the entry exists.
- A different request under a used key is refused with 409 while the first one is
  running and after it finished below 500. After a throw or a 5xx the key is free
  again, and the next request under it runs, whatever it contains.

## Limits

- **Keys are not scoped to a caller.** Entries are keyed by `kind` and `key` only.
  Any caller that sends the same key and the same request gets the stored status
  and body, and nothing inside `run` runs on a replay, permission checks included.
  Check authorization before `withIdempotency`, make keys unguessable
  (`crypto.randomUUID()`), and add the caller or tenant id to `request` (or to the
  key) when one caller's answer must never reach another.
- **The process dies after the provider call, before the response is stored.** The
  claim stays `in_flight` and retries get 409 until
  `expire_stale_payment_idempotency()` deletes claims older than 10 minutes. After
  that, a retry calls the provider again. If the first call went through at the
  provider, that is a second charge. The same happens when storing the response
  fails: the caller still gets the response, the error is logged, and the claim
  stays `in_flight`. If your provider accepts an idempotency key, send it the same
  key, so the provider refuses the duplicate itself. If it does not, look the
  payment up at the provider before charging again.
- **A throw or a 5xx answer frees the key.** Throw or answer 500 or higher only
  when the provider did not act on the request. For an unclear outcome, such as a
  timeout after the request was sent, answer below 500 so the result is stored and
  retries do not reach the provider.
- **It fails open.** If the claim cannot be written for any reason other than a
  duplicate key (missing table, missing grants, database down), `run` is called
  without protection and the error goes to `console.error`. Payments keep working
  during a database outage, but unprotected. Watch for these log lines.
- **It fails closed on an unreadable entry.** If the key is taken but the entry
  cannot be read, the answer is 409 and `run` is not called.
- **Expiry only runs when you call it.** Schedule
  `expire_stale_payment_idempotency()`, for example every few minutes with
  pg_cron. The 10-minute window must be longer than your slowest `run`, or a retry
  can call the provider while the first call is still running. Deletes and updates
  match on the key alone, so when a claim expires while its `run` is still going,
  a late throw or 5xx from that first call deletes the claim of the request that
  came after it, and a late success overwrites that request's entry.
- **Finished entries are kept.** The SQL never deletes them. If you delete old
  entries yourself, a retry with an old key calls the provider again.
- **Bodies are stored as JSON.** A body that is not JSON is stored as
  `{ "raw": "<text>" }`, and replays return that object. Statuses that cannot carry
  a body (204, 205, 304) are not supported, because the module always builds a
  `Response` with a body. Replays parse and re-serialize the stored JSON, so
  integers above 2^53 lose precision: send ids as strings. Every answer below 500
  is stored and replayed for good, 408 and 429 included; when the provider did not
  act on the request, answer with a 5xx instead so a retry reaches `run`.
- **Logs.** The module writes to `console.warn`, `console.error` and
  `console.info` with an `[idempotency]` prefix. The warning for an unprotected
  call includes `callerId`.

## SQL setup

Run `sql/payment_idempotency.sql` once, for example as a Supabase migration. It
can be run more than once. It creates:

- the table `public.payment_idempotency`: `key` (primary key), `kind` (`payment`
  or `refund`), `caller_id`, `request_hash`, `status` (`in_flight` or `done`), the
  stored `http_status` and `response`, `created_at` and `updated_at`,
- row level security on that table with no policies, no access for `public`,
  `anon` and `authenticated`, and select, insert, update and delete for
  `service_role`,
- a partial index on `created_at` that covers `in_flight` claims only, for the
  expiry function,
- the function `public.expire_stale_payment_idempotency()`, which deletes
  `in_flight` claims older than 10 minutes and returns how many it deleted. Only
  `service_role` may call it.

The SQL uses the Supabase roles `anon`, `authenticated` and `service_role`, and
fails on a database where they do not exist. On plain Postgres, create them or
edit the grants. The role the module connects with needs `BYPASSRLS` or must own
the table, because row level security without policies stops every other role
from inserting rows.

## Using another database client

`IdempotencyClient` is the part of the supabase-js query builder that the module
calls:

- `from(table).insert(row)`, which must report `error.code === "23505"` when the
  key already exists,
- `from(table).select(columns).eq("key", key).maybeSingle()`,
- `from(table).update(row).eq("key", key)`,
- `from(table).delete().eq("key", key)`.

Each returns a promise of `{ error }`, plus `data` for the read. To use another
client, implement these four calls against the same table.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The 18 tests use an in-memory table. They cover replay, concurrent duplicates,
changed requests, stored error answers, failures of the table itself and the
request hash.

## License

MIT
