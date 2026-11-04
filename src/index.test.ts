import { afterEach, describe, expect, it, vi } from "vitest";
import {
    isValidIdempotencyKey,
    requestHash,
    withIdempotency,
    type IdempotencyClient,
    type IdempotencyMeta,
    type StoredEntry,
} from "./index.js";

const HEADERS = { "Access-Control-Allow-Origin": "*" };

function memoryClient(seed: StoredEntry[] = []) {
    const rows = new Map(seed.map((r) => [r.key, r]));
    const calls: string[] = [];
    const client = {
        from: (_table: string) => ({
            insert: async (row: Record<string, unknown>) => {
                calls.push("insert");
                if (rows.has(row.key as string)) return { error: { code: "23505", message: "duplicate key" } };
                rows.set(row.key as string, { http_status: null, response: null, ...row } as unknown as StoredEntry);
                return { error: null };
            },
            select: () => ({
                eq: (_column: string, key: string) => ({ maybeSingle: async () => ({ data: rows.get(key) ?? null, error: null }) }),
            }),
            update: (patch: Record<string, unknown>) => ({
                eq: async (_column: string, key: string) => {
                    calls.push("update");
                    const current = rows.get(key);
                    if (current) rows.set(key, { ...current, ...(patch as Partial<StoredEntry>) });
                    return { error: null };
                },
            }),
            delete: () => ({
                eq: async (_column: string, key: string) => {
                    calls.push("delete");
                    rows.delete(key);
                    return { error: null };
                },
            }),
        }),
    } satisfies IdempotencyClient;
    return { client, rows, calls };
}

function withOverrides(base: IdempotencyClient, overrides: Partial<ReturnType<IdempotencyClient["from"]>>): IdempotencyClient {
    return { from: (table) => ({ ...base.from(table), ...overrides }) };
}

function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("isValidIdempotencyKey", () => {
    it("accepts 8 to 128 letters, digits, colons, underscores and hyphens", () => {
        expect(isValidIdempotencyKey("3f0c9a4e-1b7d-4d2a-9c8e-5a6b7c8d9e0f")).toBe(true);
        expect(isValidIdempotencyKey(crypto.randomUUID())).toBe(true);
        expect(isValidIdempotencyKey("order:A_b-9")).toBe(true);
        expect(isValidIdempotencyKey("a".repeat(8))).toBe(true);
        expect(isValidIdempotencyKey("a".repeat(128))).toBe(true);
    });

    it("rejects short, long, odd characters and non-strings", () => {
        expect(isValidIdempotencyKey("a".repeat(7))).toBe(false);
        expect(isValidIdempotencyKey("a".repeat(129))).toBe(false);
        expect(isValidIdempotencyKey("has space")).toBe(false);
        expect(isValidIdempotencyKey("slash/key1")).toBe(false);
        expect(isValidIdempotencyKey("dot.key.12")).toBe(false);
        expect(isValidIdempotencyKey("abcdefg" + String.fromCharCode(233))).toBe(false);
        expect(isValidIdempotencyKey("")).toBe(false);
        expect(isValidIdempotencyKey(undefined)).toBe(false);
        expect(isValidIdempotencyKey(null)).toBe(false);
        expect(isValidIdempotencyKey(12345678)).toBe(false);
    });
});

describe("requestHash", () => {
    it("is stable across key order and number formatting", async () => {
        const a = await requestHash({ amount: 10, transactionId: "t1", provider: "acme" });
        const b = await requestHash({ provider: "acme", transactionId: "t1", amount: 10.0 });
        const c = await requestHash({ provider: "acme", transactionId: "t1", amount: 11 });
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it("is the SHA-256 hex of the sorted pairs", async () => {
        expect(await requestHash({ transactionId: "t1", amount: 40 })).toBe(
            "03c09e656f681eb3a98c650759272108704622142c69e0b8f28040408e155c81",
        );
    });

    it("compares numbers to two decimals, treats empty values alike and does not look inside nested values", async () => {
        expect(await requestHash({ amount: 10.001 })).toBe(await requestHash({ amount: 10 }));
        expect(await requestHash({ amount: 10.01 })).not.toBe(await requestHash({ amount: 10 }));
        expect(await requestHash({ note: null })).toBe(await requestHash({ note: "" }));
        expect(await requestHash({ note: undefined })).toBe(await requestHash({ note: "" }));
        expect(await requestHash({ cart: { total: 1 } })).toBe(await requestHash({ cart: { total: 2 } }));
    });
});

describe("withIdempotency", () => {
    const meta: IdempotencyMeta = {
        key: "refund-00000001",
        kind: "refund",
        callerId: "caller-1",
        request: { transactionId: "t1", amount: 40 },
    };
    const scopedKey = "refund:" + meta.key;

    it("calls the provider once and replays the stored answer for the same key", async () => {
        const { client, calls } = memoryClient();
        const run = vi.fn(async () => ok({ success: true, refundId: "R-1" }));

        const first = await withIdempotency(client, meta, HEADERS, run);
        const second = await withIdempotency(client, meta, HEADERS, run);

        expect(run).toHaveBeenCalledTimes(1);
        expect(await first.json()).toEqual({ success: true, refundId: "R-1" });
        expect(second.status).toBe(200);
        expect(second.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(second.headers.get("Content-Type")).toBe("application/json");
        expect(await second.json()).toEqual({ success: true, refundId: "R-1" });
        expect(calls).toEqual(["insert", "update", "insert"]);
    });

    it("answers 409 while the first call is still in flight", async () => {
        const { client } = memoryClient([
            { key: scopedKey, kind: "refund", request_hash: await requestHash(meta.request), status: "in_flight", http_status: null, response: null },
        ]);
        const run = vi.fn(async () => ok({ success: true }));

        const response = await withIdempotency(client, meta, HEADERS, run);

        expect(run).not.toHaveBeenCalled();
        expect(response.status).toBe(409);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.get("Content-Type")).toBe("application/json");
        expect(await response.json()).toMatchObject({ success: false, errorMessage: expect.stringContaining("still in progress") });
    });

    it("lets only one of two simultaneous calls reach the provider", async () => {
        const { client, calls } = memoryClient();
        const provider = gate();
        const run = vi.fn(async () => {
            await provider.opened;
            return ok({ success: true, refundId: "R-1" });
        });

        const both = Promise.all([withIdempotency(client, meta, HEADERS, run), withIdempotency(client, meta, HEADERS, run)]);
        await vi.waitFor(() => expect(calls.filter((c) => c === "insert")).toHaveLength(2));
        provider.open();
        const responses = await both;

        expect(run).toHaveBeenCalledTimes(1);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        const loser = responses.find((r) => r.status === 409);
        expect(await loser?.json()).toMatchObject({ errorMessage: expect.stringContaining("still in progress") });
    });

    it("refuses the same key with a different request", async () => {
        const { client } = memoryClient([
            { key: scopedKey, kind: "refund", request_hash: "other", status: "done", http_status: 200, response: { success: true } },
        ]);
        const run = vi.fn(async () => ok({ success: true }));

        const response = await withIdempotency(client, meta, HEADERS, run);

        expect(run).not.toHaveBeenCalled();
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ errorMessage: expect.stringContaining("different request") });
    });

    it("refuses a changed amount under a used key, while in flight and after", async () => {
        const { client } = memoryClient();
        const provider = gate();
        const run = vi.fn(async () => {
            await provider.opened;
            return ok({ success: true });
        });
        const changed = { ...meta, request: { ...meta.request, amount: 41 } };

        const first = withIdempotency(client, meta, HEADERS, run);
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        const during = await withIdempotency(client, changed, HEADERS, run);
        provider.open();
        expect((await first).status).toBe(200);
        const after = await withIdempotency(client, changed, HEADERS, run);

        expect(run).toHaveBeenCalledTimes(1);
        for (const response of [during, after]) {
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({ errorMessage: expect.stringContaining("different request") });
        }
    });

    it("drops the reservation when the provider call throws or answers 5xx, so a retry reaches the provider", async () => {
        const { client, rows } = memoryClient();
        const boom = vi.fn(async () => {
            throw new Error("network");
        });
        await expect(withIdempotency(client, meta, HEADERS, boom)).rejects.toThrow("network");
        expect(rows.size).toBe(0);

        const flaky = vi.fn(async () => ok({ success: false, errorMessage: "gateway down" }, 502));
        const response = await withIdempotency(client, meta, HEADERS, flaky);
        expect(response.status).toBe(502);
        expect(rows.size).toBe(0);

        const healthy = vi.fn(async () => ok({ success: true, refundId: "R-2" }));
        const retry = await withIdempotency(client, meta, HEADERS, healthy);
        expect(healthy).toHaveBeenCalledTimes(1);
        expect(retry.status).toBe(200);
        expect(rows.get(scopedKey)).toMatchObject({ status: "done", http_status: 200, response: { success: true, refundId: "R-2" } });
    });

    it("stores a business decline so a retry does not ask the provider again", async () => {
        const { client } = memoryClient();
        const declined = vi.fn(async () => ok({ success: false, errorMessage: "Insufficient funds" }, 200));

        await withIdempotency(client, meta, HEADERS, declined);
        const replay = await withIdempotency(client, meta, HEADERS, declined);

        expect(declined).toHaveBeenCalledTimes(1);
        expect(await replay.json()).toEqual({ success: false, errorMessage: "Insufficient funds" });
    });

    it("stores and replays 4xx answers with their status, and wraps a body that is not JSON", async () => {
        const { client } = memoryClient();
        const declined = vi.fn(async () => ok({ success: false, errorMessage: "Card declined" }, 402));

        const first = await withIdempotency(client, meta, HEADERS, declined);
        const replay = await withIdempotency(client, meta, HEADERS, declined);

        expect(declined).toHaveBeenCalledTimes(1);
        expect(first.status).toBe(402);
        expect(replay.status).toBe(402);
        expect(await replay.json()).toEqual({ success: false, errorMessage: "Card declined" });

        const plain = { ...meta, key: "a1b2c3d4-plain-text" };
        const invalid = vi.fn(async () => new Response("bad request", { status: 400, headers: { "Content-Type": "text/plain" } }));

        const original = await withIdempotency(client, plain, HEADERS, invalid);
        const wrapped = await withIdempotency(client, plain, HEADERS, invalid);

        expect(invalid).toHaveBeenCalledTimes(1);
        expect(original.status).toBe(400);
        expect(original.headers.get("Content-Type")).toBe("text/plain");
        expect(await original.text()).toBe("bad request");
        expect(wrapped.status).toBe(400);
        expect(await wrapped.json()).toEqual({ raw: "bad request" });
    });

    it("keeps payment and refund keys apart", async () => {
        const { client, rows } = memoryClient();
        const run = vi.fn(async () => ok({ success: true }));

        const payment = await withIdempotency(client, { ...meta, kind: "payment", request: { amount: 40 } }, HEADERS, run);
        const refund = await withIdempotency(client, meta, HEADERS, run);

        expect(run).toHaveBeenCalledTimes(2);
        expect([payment.status, refund.status]).toEqual([200, 200]);
        expect([...rows.keys()].sort()).toEqual(["payment:" + meta.key, scopedKey]);
    });

    it("runs unprotected (with a warning) when the client sent no key or a malformed one", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { client, calls } = memoryClient();
        const run = vi.fn(async () => ok({ success: true }));

        await withIdempotency(client, { ...meta, key: undefined }, HEADERS, run);
        await withIdempotency(client, { ...meta, key: undefined }, HEADERS, run);
        await withIdempotency(client, { ...meta, key: "short" }, HEADERS, run);

        expect(run).toHaveBeenCalledTimes(3);
        expect(calls).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it("runs unprotected and logs when the key cannot be claimed", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { client } = memoryClient();
        const broken = withOverrides(client, {
            insert: async () => ({ error: { code: "42P01", message: "relation does not exist" } }),
        });
        const run = vi.fn(async () => ok({ success: true }));

        const response = await withIdempotency(broken, meta, HEADERS, run);

        expect(run).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
        expect(error).toHaveBeenCalled();
    });

    it("answers 409 without calling the provider when the existing entry cannot be read", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { client } = memoryClient();
        const unreadable = withOverrides(client, {
            insert: async () => ({ error: { code: "23505", message: "duplicate key" } }),
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "timeout" } }) }) }),
        });
        const run = vi.fn(async () => ok({ success: true }));

        const response = await withIdempotency(unreadable, meta, HEADERS, run);

        expect(run).not.toHaveBeenCalled();
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ success: false, errorMessage: expect.stringContaining("already sent") });
    });

    it("keeps the key in flight when the response cannot be stored, so a retry does not reach the provider", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { client, rows } = memoryClient();
        const failing = withOverrides(client, {
            update: () => ({ eq: async () => ({ error: { message: "connection lost" } }) }),
        });
        const run = vi.fn(async () => ok({ success: true, refundId: "R-1" }));

        const first = await withIdempotency(failing, meta, HEADERS, run);
        const retry = await withIdempotency(failing, meta, HEADERS, run);

        expect(await first.json()).toEqual({ success: true, refundId: "R-1" });
        expect(error).toHaveBeenCalled();
        expect(rows.get(scopedKey)?.status).toBe("in_flight");
        expect(run).toHaveBeenCalledTimes(1);
        expect(retry.status).toBe(409);
    });
});
