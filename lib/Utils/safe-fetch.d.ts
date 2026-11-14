import type { LookupFunction } from 'net';
export declare class SafeFetchError extends Error {
    code: string;
    host?: string;
    address?: string;
    statusCode?: number;
    limit?: number;
    constructor(code: string, message: string, extra?: Record<string, unknown>);
}
export declare const SAFE_FETCH_DEFAULTS: Readonly<{
    timeout: 3000;
    maxRedirects: 5;
    maxBytes: number;
}>;
/** true when `address` must never be contacted. Unparseable input is blocked (fail closed). */
export declare const isBlockedAddress: (address: string) => boolean;
export declare const createGuardedLookup: (opts?: {
    lookup?: LookupFunction;
    isBlocked?: (address: string) => boolean;
}) => LookupFunction;
export type SafeHttpGetOptions = {
    /** idle/connect timeout per hop in ms (default 3000) */
    timeout?: number;
    /** hard deadline for the whole call incl. redirects (default 3 x timeout) */
    totalTimeout?: number;
    /** response cap in bytes, applied after decompression (default 1 MiB) */
    maxBytes?: number;
    /** 'throw' (default) or 'truncate' when the cap is hit */
    onLimit?: 'throw' | 'truncate';
    /** default 5 */
    maxRedirects?: number;
    /** 'any' (default) | 'same-host' | 'none'. Every hop is address-checked either way. */
    redirects?: 'any' | 'same-host' | 'none';
    headers?: Record<string, string>;
    /** return false to skip downloading the body */
    shouldReadBody?: (status: number, headers: Record<string, string>) => boolean;
    /** explicit opt-out of the address policy (default false) */
    allowPrivateNetworks?: boolean;
    /** injection points (host hooks, tests) */
    lookup?: LookupFunction;
    isBlocked?: (address: string) => boolean;
};
export type SafeHttpGetResult = {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    truncated: boolean;
    redirects: number;
};
export declare function safeHttpGet(input: string | URL, options?: SafeHttpGetOptions): Promise<SafeHttpGetResult>;
/** Reads width/height from PNG, GIF, JPEG and WebP headers without decoding. null if unknown. */
export declare const readImageDimensions: (buf: Buffer) => {
    width: number;
    height: number;
} | null;
//# sourceMappingURL=safe-fetch.d.ts.map
