import { decodeRelativePosition } from 'yjs';
/** Sumi sync v1. Binary updates and state vectors are Yjs/Yrs V1, UTF-16 offsets. */
export const LIMITS = {
    requestBytes: 24000000,
    updateBytes: 16000000,
    websocketUpdateBytes: 256000,
    messageBytes: 400000,
    eventBytes: 256000,
    vectorBytes: 32000,
    chunkBytes: 64000,
    bodyUnits: 1000000,
    structsPerUpdate: 500000,
    pages: 1000,
    devices: 32,
    connections: 16,
    subscriptions: 8,
    changesPerPage: 100,
    authSeconds: 900,
    invitationSeconds: 300,
    backupIntervalMs: 86400000,
} as const;
export interface Claims {
    spaceId: string;
    deviceId: string;
    exp: number;
    v: 1;
}
export interface DeviceCredentials {
    spaceId: string;
    deviceId: string;
    deviceSecret: string;
}
export interface Page {
    id: string;
    epoch: number;
    generation: number;
    deleted: number;
    local_date: string | null;
    sequence: number | null;
    after_id: string | null;
    version: number;
}
export interface CreatePage {
    opId: string;
    pageId: string;
    localDate: string | null;
    afterId?: string | null;
}
export interface UpdatePage {
    opId: string;
    epoch: number;
    generation: number;
    update: string;
    firstWriteDate?: string;
}
export interface ChangeLifecycle {
    opId: string;
    generation: number;
}
export type ClientMessage = {
    type: 'hello';
    protocol: 1;
} | {
    type: 'subscribe';
    pageId: string;
    epoch: number;
    stateVector: string;
} | ({
    type: 'update';
    pageId: string;
} & UpdatePage) | {
    type: 'unsubscribe';
    pageId: string;
} | {
    type: 'ping';
};
export class ApiError extends Error {
    constructor(public status: number, public code: string) {
        super(code);
    }
}
export const fail = (status: number, code: string): never => {
    throw new ApiError(status, code);
};
export function id(value: unknown): string {
    if (typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
        return fail(400, 'invalid_id');
    return value.toLowerCase();
}
export function integer(value: unknown, min = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < min)
        return fail(400, 'invalid_integer');
    return value as number;
}
export function date(value: unknown): string {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
        return fail(400, 'invalid_date');
    return value;
}
export function b64(bytes: Uint8Array): string {
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192)
        raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(raw);
}
export function unb64(value: unknown, max: number): Uint8Array {
    if (typeof value !== 'string')
        return fail(400, 'invalid_base64');
    if (value.length > Math.ceil(max / 3) * 4)
        return fail(413, 'payload_too_large');
    // Avoid a repeated-group regexp: V8 can exhaust its regexp stack on bulk updates.
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    if (value.length % 4 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding)))
        return fail(400, 'invalid_base64');
    if ((value.length / 4) * 3 - padding > max)
        return fail(413, 'payload_too_large');
    const raw = atob(value);
    if (raw.length > max)
        return fail(413, 'payload_too_large');
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export async function hash(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
}
export function randomSecret(): string {
    return b64(crypto.getRandomValues(new Uint8Array(32)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}
export function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
}
export async function readJson(req: Request): Promise<Record<string, any>> {
    if (Number(req.headers.get('content-length') ?? 0) > LIMITS.requestBytes)
        return fail(413, 'payload_too_large');
    if (!req.body)
        return fail(400, 'missing_body');
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
        const item = await reader.read();
        if (item.done)
            break;
        length += item.value.length;
        if (length > LIMITS.requestBytes) {
            await reader.cancel();
            return fail(413, 'payload_too_large');
        }
        chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return fail(400, 'invalid_json');
        return parsed;
    }
    catch {
        return fail(400, 'invalid_json');
    }
}
/** Compact immutable timing event V1, shared with write-core's WireEvent. */
export function validateTimingEvent(value: unknown): void {
    if (typeof value !== 'string' || value.length > LIMITS.eventBytes)
        return fail(400, 'invalid_timing_event');
    let event: any;
    try {
        event = JSON.parse(value);
    }
    catch {
        return fail(400, 'invalid_timing_event');
    }
    if (!Array.isArray(event) || event.length !== 4 || event[0] !== 1 ||
        ![0, 1, 2].includes(event[2]) || !Array.isArray(event[3]))
        return fail(400, 'invalid_timing_event');
    integer(event[1]);
    for (const span of event[3]) {
        if (!Array.isArray(span) || span.length !== 7 || typeof span[3] !== 'boolean' || !Array.isArray(span[4]))
            return fail(400, 'invalid_timing_event');
        if (span[2] !== null)
            integer(span[2]);
        if (span[5] !== null)
            integer(span[5]);
        if (integer(span[6]) > 3 || (event[2] === 0 && span[3]))
            return fail(400, 'invalid_timing_event');
        for (const origin of span[4]) {
            if (!Array.isArray(origin) || origin.length !== 3 || origin.some((x: unknown) => integer(x) > 0xffffffff) || origin[1] >= origin[2])
                return fail(400, 'invalid_timing_origin');
        }
        for (const encoded of span.slice(0, 2)) {
            try {
                const position = decodeRelativePosition(unb64(encoded, 128));
                if (position.tname !== null && position.tname !== 'body')
                    return fail(400, 'invalid_timing_anchor');
                if (!Number.isSafeInteger(position.assoc))
                    return fail(400, 'invalid_timing_anchor');
                for (const item of [position.item, position.type])
                    if (item &&
                        (!Number.isSafeInteger(item.client) || item.client < 0 || !Number.isSafeInteger(item.clock) || item.clock < 0))
                        return fail(400, 'invalid_timing_anchor');
            }
            catch {
                return fail(400, 'invalid_timing_anchor');
            }
        }
    }
}
