import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { mayRegister, onAllowlist, safeNext, signupMode } from "@/lib/server/accounts/policy";
import { reviewLabel } from "@/lib/client/review-labels";
import { proxy } from "@/proxy";
import type { WorkerReview } from "@/lib/types";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("sign-up policy", () => {
  it("defaults to closed (invite-only)", () => {
    expect(signupMode(env({}))).toBe("closed");
    expect(signupMode(env({ SIGNUP_MODE: "wide-open" }))).toBe("closed");
    expect(mayRegister("a@b.test", false, env({}))).toBe(false);
    expect(mayRegister("a@b.test", true, env({}))).toBe(true); // holds a supervisor invitation
  });
  it("allowlist matches exact addresses and @domains, case-insensitively", () => {
    const e = env({ SIGNUP_MODE: "allowlist", SIGNUP_ALLOWLIST: " Pat@Example.test , @crew.test " });
    expect(onAllowlist("pat@example.test", e)).toBe(true);
    expect(onAllowlist("PAT@EXAMPLE.TEST", e)).toBe(true);
    expect(onAllowlist("someone@crew.test", e)).toBe(true);
    expect(onAllowlist("someone@evilcrew.test", e)).toBe(false);
    expect(onAllowlist("someone@crew.test.evil", e)).toBe(false);
    expect(mayRegister("x@other.test", false, e)).toBe(false);
  });
  it("open admits anyone (they still must confirm their email)", () => {
    expect(mayRegister("x@y.test", false, env({ SIGNUP_MODE: "open" }))).toBe(true);
  });
});

describe("safe redirects", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNext("/invite/supervisor")).toBe("/invite/supervisor");
    expect(safeNext("/onboarding?role=supervisor&next=%2Fx")).toBe("/onboarding?role=supervisor&next=%2Fx");
  });
  it("rejects anything that could leave the site", () => {
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "javascript:alert(1)", "evil.test", "/\u0009/evil.test", "", null, undefined]) {
      expect(safeNext(bad as string, "/fallback")).toBe("/fallback");
    }
  });
});

describe("cross-site write guard (proxy)", () => {
  const req = (method: string, path: string, headers: Record<string, string>) =>
    new NextRequest(new URL(path, "http://localhost:3100"), { method, headers: { host: "localhost:3100", ...headers } });
  it("refuses API writes from another origin", async () => {
    expect((await proxy(req("POST", "/api/reviews", { origin: "https://evil.test" }))).status).toBe(403);
    expect((await proxy(req("POST", "/api/reviews", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
  it("allows same-origin writes, reads, and provider webhooks", async () => {
    expect((await proxy(req("POST", "/api/reviews", { origin: "http://localhost:3100" }))).status).not.toBe(403);
    expect((await proxy(req("GET", "/api/me", { origin: "https://evil.test" }))).status).not.toBe(403);
    expect((await proxy(req("POST", "/api/webhooks/resend", { origin: "https://evil.test" }))).status).not.toBe(403);
  });
});

describe("supervisor review labels", () => {
  const base: WorkerReview = {
    id: "r", evidenceId: "e", evidenceVersion: 2, relationshipId: "rel", status: "confirmed_observed", supervisorName: "Sky (fictional)",
    createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", decision: "confirm_observed", observedTasks: ["Brazed line set"],
    comment: null, reviewerName: "Sky (fictional)", reviewerOrganization: "Fictional Mechanical", reviewerTitle: "Lead", decidedAt: "2026-11-02T00:00:00Z",
  };
  it("observation names the exact tasks and disclaims certification", () => {
    const l = reviewLabel(base, 2);
    expect(l.short).toBe("Supervisor confirmed observing these tasks");
    expect(l.long).toContain("Brazed line set");
    expect(l.long).toMatch(/not certification or credential verification/);
    expect(l.long).toMatch(/not verified/);
    expect(l.long).not.toMatch(/independently confirmed/i);
  });
  it("document review states its limited scope", () => {
    const l = reviewLabel({ ...base, status: "confirmed_documents", decision: "confirm_documents_reviewed", observedTasks: [] }, 2);
    expect(l.short).toBe("Supervisor reviewed supporting documentation");
    expect(l.long).toMatch(/did not state that they observed the work/);
    expect(l.long).toMatch(/did not confirm the document is authentic/);
  });
  it("flags reviews of an earlier version", () => {
    expect(reviewLabel(base, 3).short).toBe("Changed since review");
  });
});
