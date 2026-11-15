/**
 * Regression: when the rate limiter can't run (its table/function isn't installed, e.g. code deployed before the
 * migrations), requests are still REFUSED, but with 503 "setup incomplete", never 429 "too many attempts".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpcResult: { data: unknown; error: { code: string } | null } = { data: null, error: { code: "PGRST202" } };
const rpc = vi.fn(async () => rpcResult);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }) }));
const signUp = vi.fn();
const resetPasswordForEmail = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createUserClient: async () => ({ auth: { signUp, resetPasswordForEmail, getUser: async () => ({ data: { user: null } }) } }) }));

const post = (body: unknown) => new Request("http://localhost:3100/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("missing rate limiter", () => {
  beforeEach(() => {
    process.env.SIGNOFF_PEPPER = "fictional-test-pepper-".padEnd(40, "x");
    rpcResult.data = null;
    rpcResult.error = { code: "PGRST202" };
    signUp.mockReset();
    resetPasswordForEmail.mockReset();
  });

  it("allow() fails closed by throwing, never by reporting the caller as over the limit", async () => {
    const { allow, LimiterUnavailableError } = await import("@/lib/server/signoff/service");
    await expect(allow("k", "v", 60, 1)).rejects.toBeInstanceOf(LimiterUnavailableError);
    rpcResult.error = null;
    rpcResult.data = false;
    await expect(allow("k", "v", 60, 1)).resolves.toBe(false);
    rpcResult.data = true;
    await expect(allow("k", "v", 60, 1)).resolves.toBe(true);
  });

  it("sign-up answers 503 'setup incomplete' and creates no account", async () => {
    const { POST } = await import("@/app/api/auth/signup/route");
    const r = await POST(post({ email: "nobody@not-allowed.example", password: "x".repeat(12) }));
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toMatch(/setup on this server is incomplete/);
    expect(body.error.message).not.toMatch(/too many/i);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("password reset and customer routes answer the same way", async () => {
    const recover = (await import("@/app/api/auth/recover/route")).POST;
    const r1 = await recover(post({ email: "nobody@example.test" }));
    expect(r1.status).toBe(503);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    process.env.SIGNOFF_ENABLED = "true";
    const gate = (await import("@/app/api/signoff/gate/route")).POST;
    const r2 = await gate(new Request("http://localhost:3100/api/signoff/gate", { method: "POST", headers: { "x-signoff-token": "a".repeat(43) } }));
    expect(r2.status).toBe(503);
  });

  it("a real over-limit answer is still 429", async () => {
    rpcResult.error = null;
    rpcResult.data = false;
    const { POST } = await import("@/app/api/auth/signup/route");
    const r = await POST(post({ email: "nobody@not-allowed.example", password: "x".repeat(12) }));
    expect(r.status).toBe(429);
  });
});
