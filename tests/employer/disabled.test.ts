/**
 * Employer sharing OFF: every employer page and API answers a real 404 from the proxy, before sign-in redirects or
 * role routing, so the disabled feature looks the same to everyone. Other paths are unaffected. No network: the
 * Supabase URL points at a closed local port, so a request that gets past the gate shows up as a sign-in redirect.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { employerDisabledResponse, isEmployerPath } from "@/lib/server/employer/routes";

const PAGES = ["/employer", "/employer/7c51ce17-fd7b-4b99-9179-f25842ae99a9", "/invite/employer", "/share"];
const APIS = [
  ["GET", "/api/employer/shares"],
  ["GET", "/api/employer/shares/7c51ce17-fd7b-4b99-9179-f25842ae99a9"],
  ["GET", "/api/employer/shares/7c51ce17-fd7b-4b99-9179-f25842ae99a9/document"],
  ["POST", "/api/employer/invite/peek"],
  ["POST", "/api/employer/invite/accept"],
  ["GET", "/api/employer-shares"],
  ["POST", "/api/employer-shares"],
  ["GET", "/api/employer-shares/candidates"],
  ["POST", "/api/employer-shares/preview"],
  ["DELETE", "/api/employer-shares/7c51ce17-fd7b-4b99-9179-f25842ae99a9"],
] as const;

describe("isEmployerPath", () => {
  it("matches employer paths and their sub-paths only", () => {
    for (const p of [...PAGES, ...APIS.map(([, p]) => p)]) expect(isEmployerPath(p)).toBe(true);
    for (const p of ["/", "/passport", "/shared", "/sharex", "/employers", "/invite/supervisor", "/invite/employerx", "/api/employers", "/api/me", "/signoff", "/supervisor"]) {
      expect(isEmployerPath(p)).toBe(false);
    }
  });

  it("the response is null when the feature is on", () => {
    expect(employerDisabledResponse("/employer", { EMPLOYER_REVIEW_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(employerDisabledResponse("/passport", {} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("proxy with employer sharing off", () => {
  let proxy: (r: NextRequest) => Promise<Response>;
  const at = (path: string, method = "GET") => proxy(new NextRequest(new URL(path, "http://localhost:3100"), { method, headers: { origin: "http://localhost:3100", host: "localhost:3100" } }));
  beforeAll(async () => {
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fictional", NEXT_PUBLIC_DATA_MODE: "live" });
    ({ proxy } = await import("@/proxy"));
  });
  afterEach(() => { delete process.env.EMPLOYER_REVIEW_ENABLED; });

  it.each(PAGES)("page %s is a real 404 (no sign-in redirect, no role redirect)", async (path) => {
    for (const v of [undefined, "false", "1", "TRUE"]) {
      if (v === undefined) delete process.env.EMPLOYER_REVIEW_ENABLED; else process.env.EMPLOYER_REVIEW_ENABLED = v;
      const r = await at(path);
      expect(r.status).toBe(404);
      expect(r.headers.get("location")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).toMatch(/Page not found/);
    }
  });

  it.each(APIS)("%s %s answers 404 JSON before any sign-in check", async (method, path) => {
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    const r = await at(path, method);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
  });

  it("other pages still go through sign-in as before", async () => {
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    for (const p of ["/passport", "/shared", "/supervisor"]) expect((await at(p)).headers.get("location")).toContain("/sign-in");
  });

  it("with the feature on, employer pages are not blocked by the gate (signed out → sign-in)", async () => {
    process.env.EMPLOYER_REVIEW_ENABLED = "true";
    expect((await at("/employer")).headers.get("location")).toContain("/sign-in");
    expect((await at("/share")).headers.get("location")).toContain("/sign-in");
  });
});
