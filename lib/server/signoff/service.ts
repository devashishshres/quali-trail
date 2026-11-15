import "server-only";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signoffEnabled } from "./config";
import { hmac } from "./crypto";
import { logSignoffError } from "./redact";

export const SESSION_COOKIE = "qt_signoff";
export const TOKEN_HEADER = "x-signoff-token";
export const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" } as const;

type RpcResult = { ok: boolean; reason?: string } & Record<string, unknown>;

/** Calls a service-role-only database function. The result never contains secrets we did not ask for. */
export async function rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await createAdminClient().rpc(name, args);
  if (error) {
    logSignoffError(`rpc:${name}`, new Error(`code ${error.code}`));
    return { ok: false, reason: "error" };
  }
  return (data ?? { ok: false, reason: "error" }) as RpcResult;
}

/** Calls a service-role-only function that returns a plain value (boolean, text, array). */
export async function rpcValue<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await createAdminClient().rpc(name, args);
  if (error) {
    logSignoffError(`rpc:${name}`, new Error(`code ${error.code}`));
    return null;
  }
  return data as T;
}

export const off = () => NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404, headers: NO_STORE });
export const gone = () =>
  NextResponse.json({ error: { code: "not_found", message: "This link is not valid, or it has expired." } }, { status: 404, headers: NO_STORE });
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
export const tooMany = () =>
  NextResponse.json({ error: { code: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." } }, { status: 429, headers: NO_STORE });

/** True when the feature flag is on. When off, customer and worker routes behave as if they do not exist. */
export const featureOn = () => signoffEnabled();

/** The rate limiter itself can't run (for example its table isn't installed yet). The request is refused. */
export class LimiterUnavailableError extends Error {
  constructor() {
    super("rate limiter unavailable");
  }
}

/**
 * Fixed-window limit on a hashed key (never a raw address or IP). Returns true when the call is allowed and false
 * when the caller is over the limit. If the limiter can't run, it FAILS CLOSED by throwing LimiterUnavailableError,
 * which `guarded` turns into a "temporarily unavailable" answer instead of a misleading "too many attempts".
 */
export async function allow(kind: string, rawKey: string, windowSeconds: number, max: number): Promise<boolean> {
  const r = await createAdminClient().rpc("signoff_hit_rate_limit", {
    p_key_hash: hmac("rate", `${kind}:${rawKey}`),
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (r.error || typeof r.data !== "boolean") {
    logSignoffError("rate-limiter", new Error(`unavailable (code ${r.error?.code ?? "no result"})`));
    throw new LimiterUnavailableError();
  }
  return r.data;
}

export const UNAVAILABLE_MESSAGE = "This isn't available right now because setup on this server is incomplete. Please try again later.";
export const setupIncomplete = () =>
  NextResponse.json({ error: { code: "unavailable", message: UNAVAILABLE_MESSAGE } }, { status: 503, headers: NO_STORE });

/** Wraps a route handler so a missing rate limiter answers 503 "setup incomplete". Every other error is rethrown. */
export function guarded<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof LimiterUnavailableError) return setupIncomplete();
      throw e;
    }
  };
}

/**
 * The client address used ONLY as a rate-limit key (hashed, never stored raw).
 * Forwarded headers are trusted only on the supported host, Vercel, whose edge overwrites `x-real-ip` and
 * `x-forwarded-for` with the connecting address, so a client cannot choose its own value.
 * Anywhere else (local, or an unsupported host) forwarded headers are ignored and every caller shares one bucket:
 * stricter, never spoofable. Supporting another host means adding its trusted header here deliberately.
 */
export function clientIpFrom(h: Pick<Headers, "get">, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERCEL === "1") {
    const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0];
    if (ip && ip.trim()) return `vercel:${ip.trim()}`;
  }
  return "untrusted-shared";
}

export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}

/** Customer requests identify the invitation by an `x-signoff-token` header (the link fragment never reaches a server). */
export async function tokenHash(request: Request): Promise<string | null> {
  const token = request.headers.get(TOKEN_HEADER);
  return token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? hmac("token", token) : null;
}

export async function sessionHash(): Promise<string | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? hmac("session", value) : null;
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
}
