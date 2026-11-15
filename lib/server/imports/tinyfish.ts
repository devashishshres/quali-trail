/**
 * TinyFish Fetch API client. Sends ONE public listing URL and nothing else: never the technician's profile,
 * evidence, documents or identity. No forms, no logins, no applications; Fetch only retrieves a page.
 *
 * Documented behaviour this relies on (docs.tinyfish.ai/fetch-api/reference):
 *  - POST https://api.fetch.tinyfish.ai/ with X-API-Key; body { urls, format, per_url_timeout_ms (1..110000) }.
 *  - Per-URL failures arrive in errors[] (HTTP 200); request failures as 400/401/402/403/422/429/500/503.
 *  - Private IPs, localhost and cloud metadata endpoints are rejected (invalid_url), including redirect
 *    targets (invalid_redirect_url). Oversized pages fail (content_too_large) rather than arrive truncated.
 * The key is read server-side only and never logged.
 */
export const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai/";

export type FetchErrorCode =
  | "not_found"
  | "blocked"
  | "login_required"
  | "unreachable"
  | "timeout"
  | "empty"
  | "too_large"
  | "invalid_url"
  | "provider_unavailable"
  | "provider_config";

export class ListingFetchError extends Error {
  constructor(readonly code: FetchErrorCode, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ListingFetchError";
  }
}

export interface FetchedListing {
  title: string | null;
  finalUrl: string;
  text: string;
  requestId: string | null;
}

const PER_URL_ERRORS: Record<string, [FetchErrorCode, string, boolean]> = {
  page_not_found: ["not_found", "That job listing wasn't found. It may have been taken down.", false],
  target_http_error: ["unreachable", "The job site returned an error for that page.", true],
  target_unreachable: ["unreachable", "The job site couldn't be reached.", true],
  timeout: ["timeout", "The job site took too long to respond.", true],
  bot_blocked: ["blocked", "That job site blocks automated retrieval. Paste the listing text instead.", false],
  empty_content: ["empty", "No readable text was found on that page. Paste the listing text instead.", false],
  login_required: ["login_required", "That listing needs a sign-in to view. Paste the listing text instead.", false],
  content_too_large: ["too_large", "That page is too large to import. Paste the listing text instead.", false],
  invalid_url: ["invalid_url", "That address can't be retrieved because it isn't a public web page.", false],
  invalid_redirect_url: ["invalid_url", "That link redirects to an address that isn't a public web page.", false],
  proxy_error: ["unreachable", "The retrieval service couldn't reach the job site.", true],
};

export interface FetchOptions {
  apiKey: string;
  /** Hard deadline for this call, in ms. The request is aborted when it passes. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export async function fetchListingLive(url: string, opts: FetchOptions): Promise<FetchedListing> {
  const f = opts.fetchImpl ?? fetch;
  // Leave the provider a little less than our own deadline so its own timeout reports first.
  const perUrl = Math.max(1000, Math.min(110_000, opts.timeoutMs - 3000));
  let res: Response;
  try {
    res = await f(TINYFISH_FETCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": opts.apiKey },
      body: JSON.stringify({ urls: [url], format: "markdown", per_url_timeout_ms: perUrl }),
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ListingFetchError("timeout", "Retrieving the listing took too long.", true);
    throw new ListingFetchError("provider_unavailable", "The listing retrieval service couldn't be reached.", true);
  }
  if (res.status === 401 || res.status === 403) throw new ListingFetchError("provider_config", "Listing retrieval isn't set up correctly on this server.", false);
  if (res.status === 402) throw new ListingFetchError("provider_config", "Listing retrieval is unavailable on this server right now.", false);
  if (res.status === 429 || res.status === 503 || res.status >= 500) throw new ListingFetchError("provider_unavailable", "The listing retrieval service is busy. Try again in a few minutes.", true);
  if (!res.ok) throw new ListingFetchError("invalid_url", "That link couldn't be retrieved.", false);

  let body: { results?: unknown[]; errors?: { error?: string }[]; request_id?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    throw new ListingFetchError("provider_unavailable", "The listing retrieval service sent an unreadable answer.", true);
  }
  const err = body?.errors?.[0]?.error;
  if (err) {
    const [code, message, retryable] = PER_URL_ERRORS[err] ?? (["unreachable", "That listing couldn't be retrieved.", true] as const);
    throw new ListingFetchError(code, message, retryable);
  }
  const r = body?.results?.[0] as { final_url?: unknown; url?: unknown; title?: unknown; text?: unknown } | undefined;
  if (!r || typeof r.text !== "string") throw new ListingFetchError("empty", "No readable text was found on that page. Paste the listing text instead.", false);
  if (!r.text.trim()) throw new ListingFetchError("empty", "No readable text was found on that page. Paste the listing text instead.", false);
  return {
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 300) : null,
    finalUrl: typeof r.final_url === "string" && r.final_url ? r.final_url : typeof r.url === "string" ? r.url : url,
    text: r.text,
    requestId: typeof body?.request_id === "string" ? body.request_id.slice(0, 200) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Stub (isolated local development and tests only)                    */
/* ------------------------------------------------------------------ */

/** Fictional listings. Path selects one; "/slow" and "/blocked" simulate provider failures. */
export const STUB_LISTINGS: Record<string, { title: string; text: string }> = {
  "/hvac-tech": {
    title: "Residential HVAC Installer (FICTIONAL TEST LISTING)",
    text: `# Residential HVAC Installer (FICTIONAL TEST LISTING)
Fictional Comfort Co. (not a real employer) — Phoenix, AZ

This listing is invented for QualiTrail testing. It is not a real job.

## Requirements
- EPA 608 Type II or Universal certification
- Documented hands-on experience installing and starting up residential heat-pump systems
- 3+ years of HVAC installation experience
- Valid driver's license and clean driving record

## Preferred
- NATE certification
- Brazing experience

## Benefits
- Fictional benefits for testing only`,
  },
};

export async function fetchListingStub(url: string, opts: { timeoutMs: number }): Promise<FetchedListing> {
  const path = new URL(url).pathname;
  if (path === "/slow") {
    await new Promise((r) => setTimeout(r, opts.timeoutMs + 50));
    throw new ListingFetchError("timeout", "Retrieving the listing took too long.", true);
  }
  if (path === "/blocked") throw new ListingFetchError("blocked", PER_URL_ERRORS.bot_blocked[1], false);
  const l = STUB_LISTINGS[path];
  if (!l) throw new ListingFetchError("not_found", PER_URL_ERRORS.page_not_found[1], false);
  return { title: l.title, finalUrl: url, text: l.text, requestId: "stub" };
}
