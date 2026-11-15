import { describe, expect, it } from "vitest";
import { fetchListingLive, ListingFetchError, TINYFISH_FETCH_URL } from "@/lib/server/imports/tinyfish";

const KEY = "test-key-not-real";
const URL1 = "https://jobs.example.com/listing/1";

function fake(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchListingLive", () => {
  it("sends ONLY the listing URL, format and timeout, with the key in a header", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const out = await fetchListingLive(URL1, { apiKey: KEY, timeoutMs: 45_000, fetchImpl: fake(200, { results: [{ url: URL1, final_url: URL1, title: "T", text: "Listing" }], errors: [], request_id: "r1" }, seen) });
    expect(out).toEqual({ title: "T", finalUrl: URL1, text: "Listing", requestId: "r1" });
    expect(seen[0].url).toBe(TINYFISH_FETCH_URL);
    const body = JSON.parse(String(seen[0].init?.body));
    expect(Object.keys(body).sort()).toEqual(["format", "per_url_timeout_ms", "urls"]);
    expect(body).toEqual({ urls: [URL1], format: "markdown", per_url_timeout_ms: 42_000 });
    expect((seen[0].init?.headers as Record<string, string>)["X-API-Key"]).toBe(KEY);
    expect(String(seen[0].init?.body)).not.toContain(KEY);
  });

  it.each([
    ["bot_blocked", "blocked", false],
    ["login_required", "login_required", false],
    ["invalid_redirect_url", "invalid_url", false],
    ["invalid_url", "invalid_url", false],
    ["timeout", "timeout", true],
    ["page_not_found", "not_found", false],
    ["content_too_large", "too_large", false],
    ["empty_content", "empty", false],
  ])("per-URL error %s -> %s", async (provider, code, retryable) => {
    const e = await fetchListingLive(URL1, { apiKey: KEY, timeoutMs: 45_000, fetchImpl: fake(200, { results: [], errors: [{ url: URL1, error: provider }] }) }).catch((x) => x);
    expect(e).toBeInstanceOf(ListingFetchError);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
  });

  it.each([[401, "provider_config"], [402, "provider_config"], [429, "provider_unavailable"], [503, "provider_unavailable"], [400, "invalid_url"]])("HTTP %s -> %s", async (status, code) => {
    const e = await fetchListingLive(URL1, { apiKey: KEY, timeoutMs: 45_000, fetchImpl: fake(status, {}) }).catch((x) => x);
    expect(e.code).toBe(code);
    expect(e.message).not.toContain(KEY);
  });

  it("enforces its own deadline", async () => {
    const hang = ((_: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const started = Date.now();
    const e = await fetchListingLive(URL1, { apiKey: KEY, timeoutMs: 1200, fetchImpl: hang }).catch((x) => x);
    expect(e.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("an empty text result is an error, not an empty listing", async () => {
    const e = await fetchListingLive(URL1, { apiKey: KEY, timeoutMs: 45_000, fetchImpl: fake(200, { results: [{ url: URL1, final_url: URL1, text: "   " }] }) }).catch((x) => x);
    expect(e.code).toBe("empty");
  });
});
