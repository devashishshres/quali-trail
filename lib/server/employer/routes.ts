import { NextResponse } from "next/server";
import { employerReviewEnabled } from "./flags";

/**
 * Every page and API path that exists only for employer sharing. When the feature is off, the proxy answers these
 * with a plain 404 BEFORE sign-in redirects or role routing, so a disabled feature looks the same to everyone
 * (signed out, technician, supervisor, reviewer). Exact path or sub-path only, never a longer sibling.
 */
const EMPLOYER_PATHS = ["/employer", "/invite/employer", "/share", "/api/employer", "/api/employer-shares"];

export const isEmployerPath = (path: string) => EMPLOYER_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

const NO_STORE = { "Cache-Control": "no-store" };

/** The proxy's answer for an employer path while the feature is off; null when the request should continue. */
export function employerDisabledResponse(path: string, env: NodeJS.ProcessEnv = process.env): NextResponse | null {
  if (employerReviewEnabled(env) || !isEmployerPath(path)) return null;
  if (path.startsWith("/api/")) return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404, headers: NO_STORE });
  return new NextResponse(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Page not found</h1><p>This page isn\'t available.</p><p><a href="/">Go to QualiTrail</a></p></body></html>',
    { status: 404, headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" } },
  );
}
