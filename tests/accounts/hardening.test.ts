import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { configProblems, describeProblems, isolatedLocal } from "@/lib/server/config";
import { eligibleBySignupPolicy, mayCreateRole, mayRegister, type RoleState } from "@/lib/server/accounts/policy";
import nextConfig from "@/next.config";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const PEPPER = "fictional-test-pepper-".padEnd(40, "x");

describe("role eligibility: an invitation leads only to a reviewer profile", () => {
  const base: RoleState = { email: "invitee@crew.test", hasWorker: false, hasSupervisor: false, hasInvite: false, supervisorReviewOn: true };
  const closed = env({});
  it("an invited address may register and become a reviewer, never a technician", () => {
    const s = { ...base, hasInvite: true };
    expect(mayRegister(s.email, true, closed)).toBe(true);
    expect(mayCreateRole("supervisor", s, closed)).toBe(true);
    expect(mayCreateRole("worker", s, closed)).toBe(false);
  });
  it("a reviewer can't add a technician profile later unless the sign-up policy admits the address", () => {
    const s = { ...base, hasSupervisor: true };
    expect(mayCreateRole("worker", s, closed)).toBe(false);
    expect(mayCreateRole("worker", s, env({ SIGNUP_MODE: "allowlist", SIGNUP_ALLOWLIST: "@crew.test" }))).toBe(true);
    expect(mayCreateRole("worker", s, env({ SIGNUP_MODE: "open" }))).toBe(true);
  });
  it("an existing profile of the same role is always fine (idempotent)", () => {
    expect(mayCreateRole("worker", { ...base, hasWorker: true }, closed)).toBe(true);
    expect(mayCreateRole("supervisor", { ...base, hasSupervisor: true, supervisorReviewOn: false }, closed)).toBe(true);
  });
  it("a technician may add the reviewer role, but only while supervisor review is on", () => {
    expect(mayCreateRole("supervisor", { ...base, hasWorker: true }, closed)).toBe(true);
    expect(mayCreateRole("supervisor", { ...base, hasWorker: true, supervisorReviewOn: false }, closed)).toBe(false);
    expect(mayCreateRole("supervisor", { ...base, hasInvite: true, supervisorReviewOn: false }, closed)).toBe(false);
  });
  it("nobody gets anything in closed mode without an invitation", () => {
    expect(eligibleBySignupPolicy("x@y.test", closed)).toBe(false);
    expect(mayCreateRole("worker", base, closed)).toBe(false);
    expect(mayCreateRole("supervisor", base, closed)).toBe(false);
  });
});

describe("configuration validation names the variable, never its value", () => {
  const good = {
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fictional", SUPABASE_SECRET_KEY: "sb_secret_fictional_value",
    SIGNOFF_PEPPER: PEPPER, EMAIL_MODE: "resend", APP_BASE_URL: "https://app.example.test", RESEND_API_KEY: "re_fictional_value", RESEND_FROM: "QualiTrail <no-reply@mail.example.test>", RESEND_WEBHOOK_SECRET: "whsec_fictional_value",
  };
  it("a complete hosted resend setup has no problems", () => {
    expect(configProblems(env(good))).toEqual([]);
  });
  it("reports each problem by name, without values", () => {
    const p = configProblems(env({ ...good, SIGNOFF_PEPPER: "short", APP_BASE_URL: "http://app.example.test", RESEND_FROM: "nope", SIGNUP_MODE: "wide", SIGNOFF_ENABLED: "yes", NEXT_PUBLIC_RESEND_API_KEY: "re_leak_value" }));
    const names = p.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["SIGNOFF_PEPPER", "APP_BASE_URL", "RESEND_FROM", "SIGNUP_MODE", "SIGNOFF_ENABLED", "NEXT_PUBLIC_RESEND_API_KEY"]));
    const text = describeProblems(p);
    for (const secret of ["short", "re_leak_value", "sb_secret_fictional_value", "re_fictional_value", "whsec_fictional_value"]) expect(text).not.toContain(secret);
  });
  it("the pepper is required even with every feature off", () => {
    const { SIGNOFF_PEPPER: _drop, ...rest } = good;
    void _drop;
    expect(configProblems(env({ ...rest, EMAIL_MODE: "off" })).map((x) => x.name)).toEqual(["SIGNOFF_PEPPER"]);
  });
  it("mock email is refused anywhere but an isolated local setup", () => {
    const local = { ...good, EMAIL_MODE: "mock", APP_BASE_URL: "http://localhost:3100", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
    expect(isolatedLocal(env(local))).toBe(true);
    expect(configProblems(env(local))).toEqual([]);
    expect(configProblems(env({ ...local, VERCEL: "1" })).map((x) => x.name)).toContain("EMAIL_MODE");
    expect(configProblems(env({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).map((x) => x.name)).toContain("EMAIL_MODE");
  });
});

describe("rate-limit client address", () => {
  it("trusts forwarded headers only on Vercel; elsewhere every caller shares one strict bucket", async () => {
    const { clientIpFrom } = await import("@/lib/server/signoff/service");
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "203.0.113.9" });
    expect(clientIpFrom(h, env({ VERCEL: "1" }))).toBe("vercel:203.0.113.9");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "198.51.100.7" }), env({ VERCEL: "1" }))).toBe("vercel:198.51.100.7");
    // Not on Vercel: a client choosing its own X-Forwarded-For gets no fresh bucket.
    expect(clientIpFrom(h, env({}))).toBe("untrusted-shared");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "192.0.2.1" }), env({}))).toBe("untrusted-shared");
  });
});

describe("password-reset permission", () => {
  beforeAll(() => {
    process.env.SIGNOFF_PEPPER = PEPPER;
  });
  it("is bound to one user and expires after 15 minutes", async () => {
    const { recoveryValue, recoveryValid } = await import("@/lib/server/accounts/recovery");
    const now = Date.now();
    const v = recoveryValue("user-a", now);
    expect(recoveryValid(v, "user-a", now + 60_000)).toBe(true);
    expect(recoveryValid(v, "user-b", now + 60_000)).toBe(false);
    expect(recoveryValid(v, "user-a", now + 16 * 60_000)).toBe(false);
    const [exp, mac] = v.split(".");
    expect(recoveryValid(`${Number(exp) + 3_600_000}.${mac}`, "user-a", now)).toBe(false); // can't extend it
    for (const bad of [undefined, "", "x", `${exp}.zz`]) expect(recoveryValid(bad, "user-a", now)).toBe(false);
  });
});

describe("browser protections", () => {
  it("every route refuses to be framed and disables MIME sniffing", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toEqual(expect.arrayContaining([
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]));
    for (const p of ["/forgot-password", "/reset-password", "/signoff", "/auth/:path*"]) {
      expect(rules.find((r) => r.source === p)?.headers).toEqual(expect.arrayContaining([{ key: "Cache-Control", value: "no-store" }, { key: "Referrer-Policy", value: "no-referrer" }]));
    }
  });
  it("password pages are reachable signed out", async () => {
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fictional", NEXT_PUBLIC_DATA_MODE: "live" });
    const { proxy } = await import("@/proxy");
    expect((await proxy(new NextRequest(new URL("/passport", "http://localhost:3100")))).headers.get("location")).toContain("/sign-in"); // the check is live
    for (const p of ["/forgot-password", "/reset-password"]) {
      const r = await proxy(new NextRequest(new URL(p, "http://localhost:3100")));
      expect(r.headers.get("location")).toBeNull();
    }
  });
});
