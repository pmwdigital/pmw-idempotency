export type IdempotencyKind = "payment" | "refund";

export interface IdempotencyClient {
    from(table: string): {
        insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
        select(columns: string): {
            eq(column: string, value: string): {
                maybeSingle(): PromiseLike<{ data: StoredEntry | null; error: { message: string } | null }>;
            };
        };
        update(row: Record<string, unknown>): {
            eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
        };
        delete(): {
            eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
        };
    };
}

export interface StoredEntry {
    key: string;
    kind: IdempotencyKind;
    request_hash: string;
    status: "in_flight" | "done";
    http_status: number | null;
    response: unknown;
}

export interface IdempotencyMeta {
    key: string | null | undefined;
    kind: IdempotencyKind;
    callerId: string;
    request: Record<string, unknown>;
}

const TABLE = "payment_idempotency";
const KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
    return typeof value === "string" && KEY_PATTERN.test(value);
}

export async function requestHash(request: Record<string, unknown>): Promise<string> {
    const canonical = JSON.stringify(
        Object.keys(request)
            .sort()
            .map((k) => [k, typeof request[k] === "number" ? Number(request[k]).toFixed(2) : String(request[k] ?? "")]),
    );
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

export async function withIdempotency(
    client: IdempotencyClient,
    meta: IdempotencyMeta,
    headers: Record<string, string>,
    run: () => Promise<Response>,
): Promise<Response> {
    if (!isValidIdempotencyKey(meta.key)) {
        console.warn(`[idempotency] ${meta.kind}: no valid key, running unprotected`, { callerId: meta.callerId });
        return run();
    }

    const scopedKey = `${meta.kind}:${meta.key}`;
    const hash = await requestHash(meta.request);

    const { error: insertError } = await client.from(TABLE).insert({
        key: scopedKey,
        kind: meta.kind,
        caller_id: meta.callerId,
        request_hash: hash,
        status: "in_flight",
    });

    if (insertError) {
        if (insertError.code !== "23505") {
            console.error("[idempotency] could not claim the key, running unprotected", insertError.message);
            return run();
        }

        const { data: existing, error: readError } = await client.from(TABLE).select("*").eq("key", scopedKey).maybeSingle();
        if (readError || !existing) {
            console.error("[idempotency] could not read the existing entry", readError?.message);
            return json(409, { success: false, errorMessage: "This request was already sent. Check its status." }, headers);
        }
        if (existing.request_hash !== hash) {
            return json(409, { success: false, errorMessage: "This key was already used with a different request." }, headers);
        }
        if (existing.status === "in_flight") {
            return json(409, { success: false, errorMessage: "This request is still in progress. Check its status in a few seconds." }, headers);
        }
        console.info(`[idempotency] ${meta.kind}: replaying the stored response`, { key: scopedKey });
        return json(existing.http_status ?? 200, existing.response, headers);
    }

    let response: Response;
    try {
        response = await run();
    } catch (error) {
        await client.from(TABLE).delete().eq("key", scopedKey);
        throw error;
    }

    const status = response.status;
    const text = await response.text();
    let body: unknown = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = { raw: text };
    }

    if (status >= 500) {
        await client.from(TABLE).delete().eq("key", scopedKey);
    } else {
        const { error: updateError } = await client
            .from(TABLE)
            .update({ status: "done", http_status: status, response: body, updated_at: new Date().toISOString() })
            .eq("key", scopedKey);
        if (updateError) console.error("[idempotency] could not store the response", updateError.message);
    }

    return new Response(text, { status, headers: response.headers });
}
