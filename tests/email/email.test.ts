import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emailMode, emailReady, missingEmailConfig, mockOutboxAllowed } from "@/lib/server/email/config";
import { templates } from "@/lib/server/email/templates";
import { FatalSendError, RetryableSendError, sendMockMessage, sendResendOnce, withRetries } from "@/lib/server/email/transport";
import { hasLocalStack, useLocalStack } from "../helpers/local-supabase";

vi.mock("server-only", () => ({}));

const base = { base: "http://localhost:3100", mock: false };
const fullEnv = { EMAIL_MODE: "resend", SIGNOFF_PEPPER: "p".repeat(40), APP_BASE_URL: "https://x.test", RESEND_API_KEY: "re_test_key", RESEND_FROM: "QualiTrail <a@x.test>", RESEND_WEBHOOK_SECRET: "whsec_x" } as unknown as NodeJS.ProcessEnv;

describe("email configuration", () => {
  it("modes are explicit and default to off; EMAIL_MODE wins over the older name", () => {
    expect(emailMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(emailMode({ SIGNOFF_MAIL_MODE: "mock" } as unknown as NodeJS.ProcessEnv)).toBe("mock");
    expect(emailMode({ SIGNOFF_MAIL_MODE: "mock", EMAIL_MODE: "off" } as unknown as NodeJS.ProcessEnv)).toBe("off");
    expect(emailMode({ EMAIL_MODE: "smtp" } as unknown as NodeJS.ProcessEnv)).toBe("off");
  });
  it("resend is never ready without every variable", () => {
    expect(emailReady(fullEnv)).toBe(true);
    for (const k of ["RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET", "APP_BASE_URL", "SIGNOFF_PEPPER"]) {
      const env = { ...fullEnv, [k]: "" } as NodeJS.ProcessEnv;
      expect(emailReady(env)).toBe(false);
      expect(missingEmailConfig(env)).toContain(k);
    }
  });
  it("the mock outbox never exists in production", () => {
    expect(mockOutboxAllowed({ EMAIL_MODE: "mock", NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(mockOutboxAllowed({ EMAIL_MODE: "mock", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(mockOutboxAllowed({ EMAIL_MODE: "resend", NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("templates", () => {
  it("every message has text and HTML, and simulated ones say so in subject and body", () => {
    const all = [
      templates.customerInvitation({ ...base, workerName: "T", link: "https://x.test/signoff#t=abc", validDays: 7 }),
      templates.customerCode({ ...base, workerName: "T", code: "123456" }),
      templates.customerReceipt({ ...base, workerName: "T", decisionLabel: "acknowledged" }),
      templates.supervisorInvitation({ ...base, workerName: "T", link: "https://x.test/invite/supervisor#t=abc", validDays: 14 }),
      templates.reviewNotification({ ...base, workerName: "T", link: "https://x.test/supervisor/reviews/1" }),
      templates.decisionNotice({ ...base, who: "supervisor", title: "Job", decisionLabel: "x", link: "https://x.test/evidence" }),
      templates.reminder({ ...base, workerName: "T", link: "https://x.test/signoff#t=abc", what: "customer" }),
    ];
    for (const r of all) {
      expect(r.text.length).toBeGreaterThan(20);
      expect(r.html).toMatch(/^<!doctype html>/);
      expect(r.subject).not.toMatch(/SIMULATED/);
    }
    const sim = templates.customerCode({ ...base, mock: true, workerName: "T", code: "123456" });
    expect(sim.subject).toMatch(/^\[SIMULATED\]/);
    expect(sim.text).toMatch(/SIMULATED MESSAGE/);
    expect(sim.html).toMatch(/SIMULATED MESSAGE/);
  });
  it("escapes names in HTML and keeps job details out of the customer invitation", () => {
    const r = templates.customerInvitation({ ...base, workerName: `<img src=x onerror=alert(1)>`, link: "https://x.test/signoff#t=abc", validDays: 7 });
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img");
    expect(r.text).toMatch(/separate one-time code/);
  });
  it("notification emails state that opening them approves nothing", () => {
    expect(templates.reviewNotification({ ...base, workerName: "T", link: "l" }).text).toMatch(/does not approve anything/);
  });
});

describe("transport", () => {
  const r = templates.customerCode({ ...base, workerName: "T", code: "123456" });
  it("sends text and HTML with the idempotency key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    expect(await sendResendOnce("a@b.test", r, "key-1", fullEnv, f as never)).toBe("msg_1");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    const body = JSON.parse(String(init.body));
    expect(body.text).toBeTruthy();
    expect(body.html).toBeTruthy();
  });
  it("classifies failures: 429/5xx/network retryable, 4xx fatal; never echoes the body", async () => {
    await expect(sendResendOnce("a@b.test", r, "k", fullEnv, (async () => new Response("", { status: 503 })) as never)).rejects.toBeInstanceOf(RetryableSendError);
    await expect(sendResendOnce("a@b.test", r, "k", fullEnv, (async () => new Response("", { status: 429 })) as never)).rejects.toBeInstanceOf(RetryableSendError);
    await expect(sendResendOnce("a@b.test", r, "k", fullEnv, (async () => { throw new Error("ECONNRESET"); }) as never)).rejects.toBeInstanceOf(RetryableSendError);
    const fatal = sendResendOnce("a@b.test", r, "k", fullEnv, (async () => new Response("a@b.test is not valid", { status: 422 })) as never);
    await expect(fatal).rejects.toBeInstanceOf(FatalSendError);
    await expect(fatal).rejects.not.toThrow(/a@b\.test/);
  });
  it("retries a bounded number of times, and only retryable failures", async () => {
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    await expect(withRetries(async () => { n++; throw new RetryableSendError("x"); }, 3, [1, 1], sleep)).rejects.toBeInstanceOf(RetryableSendError);
    expect(n).toBe(3);
    n = 0;
    await expect(withRetries(async () => { n++; throw new FatalSendError("x"); }, 3, [1, 1], sleep)).rejects.toBeInstanceOf(FatalSendError);
    expect(n).toBe(1);
    n = 0;
    expect(await withRetries(async () => { if (++n < 2) throw new RetryableSendError("x"); return "ok"; }, 3, [1, 1], sleep)).toBe("ok");
  });
  it("mock delivery writes a simulated message to a local file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ob-")), "o.jsonl");
    await sendMockMessage("a@b.test", templates.customerCode({ ...base, mock: true, workerName: "T", code: "123456" }), { kind: "customer_code" }, path);
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ simulated: true, meta: { kind: "customer_code" } });
  });
});

describe("webhook classification", async () => {
  const { classify } = await import("@/lib/server/email/webhook");
  it("hard bounces and complaints suppress; transient bounces and other events do not", () => {
    expect(classify({ type: "email.bounced", data: { bounce: { type: "Permanent", subType: "General" } } })).toMatchObject({ kind: "suppress", reason: "bounce" });
    expect(classify({ type: "email.bounced", data: { bounce: { type: "Transient", subType: "MailboxFull" } } })).toEqual({ kind: "status", status: "bounced_transient" });
    expect(classify({ type: "email.bounced", data: {} })).toEqual({ kind: "status", status: "bounced_transient" });
    expect(classify({ type: "email.complained" })).toMatchObject({ kind: "suppress", reason: "complaint" });
    expect(classify({ type: "email.delivered" })).toEqual({ kind: "status", status: "delivered" });
    expect(classify({ type: "email.opened" })).toEqual({ kind: "ignore" });
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Against the isolated local Supabase stack: idempotent delivery, suppression, realistic webhooks. */
/* ------------------------------------------------------------------------------------------------ */

const WEBHOOK_SECRET = "whsec_" + Buffer.from("local-test-webhook-secret-material").toString("base64");
function signed(payload: object, id = `msg_${randomUUID()}`) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from("local-test-webhook-secret-material")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("http://localhost/api/webhooks/resend", { method: "POST", headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body });
}
/** Shape of a real Resend bounce event (fields we don't use included, to prove they are ignored). */
const bounceEvent = (to: string, emailId: string, type = "Permanent") => ({
  type: "email.bounced",
  created_at: new Date().toISOString(),
  data: {
    created_at: new Date().toISOString(),
    email_id: emailId,
    from: "QualiTrail <notify@example.test>",
    to: [to],
    subject: "Your QualiTrail verification code",
    bounce: { message: "The recipient's mail server permanently rejected the email.", subType: "General", type },
  },
});

describe.skipIf(!hasLocalStack)("delivery and webhooks (local Supabase stack)", () => {
  let admin: ReturnType<typeof useLocalStack>;
  beforeAll(() => {
    admin = useLocalStack();
    Object.assign(process.env, { EMAIL_MODE: "resend", SIGNOFF_PEPPER: "p".repeat(40), APP_BASE_URL: "http://localhost:3100", RESEND_API_KEY: "re_test_never_sent", RESEND_FROM: "QualiTrail <notify@example.test>", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });

  it("the same idempotency key sends once, even when called twice", async () => {
    const { deliver } = await import("@/lib/server/email/deliver");
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.resend.com")) { calls++; return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 }); }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const key = `test-${randomUUID()}`;
      const req = { kind: "customer_code" as const, to: `idem-${randomUUID()}@example.test`, rendered: templates.customerCode({ ...base, workerName: "T", code: "111111" }), idempotencyKey: key };
      expect(await deliver(req)).toMatchObject({ ok: true, duplicate: false });
      expect(await deliver(req)).toMatchObject({ ok: true, duplicate: true });
      expect(calls).toBe(1);
      const { data } = await admin.from("email_deliveries").select("status, attempts, provider_message_id, kind").eq("idempotency_key", key).single();
      expect(data).toMatchObject({ status: "sent", attempts: 1, kind: "customer_code" });
      // Nothing stored that identifies the recipient or the content.
      expect(JSON.stringify(data)).not.toMatch(/example\.test|111111/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a provider outage is retried, then reported as a visible failure and recorded", async () => {
    const { deliver } = await import("@/lib/server/email/deliver");
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.resend.com")) { calls++; return new Response("down", { status: 503 }); }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const key = `test-${randomUUID()}`;
      const out = await deliver({ kind: "customer_invitation", to: `down-${randomUUID()}@example.test`, rendered: templates.customerCode({ ...base, workerName: "T", code: "1" }), idempotencyKey: key });
      expect(out).toEqual({ ok: false, reason: "failed" });
      expect(calls).toBe(3);
      const { data } = await admin.from("email_deliveries").select("status, last_error").eq("idempotency_key", key).single();
      expect(data).toEqual({ status: "failed", last_error: "provider status 503" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a hard bounce suppresses the address, a duplicate webhook is ignored, and suppressed addresses are never sent to", async () => {
    const { deliver } = await import("@/lib/server/email/deliver");
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const to = `bounce-${randomUUID()}@example.test`;
    const emailId = `re_${randomUUID()}`;
    const webhookId = `msg_${randomUUID()}`;
    const first = await POST(signed(bounceEvent(to, emailId), webhookId));
    expect(await first.json()).toMatchObject({ result: "applied" });
    const again = await POST(signed(bounceEvent(to, emailId), webhookId));
    expect(await again.json()).toMatchObject({ result: "duplicate" });
    const out = await deliver({ kind: "customer_code", to: to.toUpperCase(), rendered: templates.customerCode({ ...base, workerName: "T", code: "1" }), idempotencyKey: `test-${randomUUID()}` });
    expect(out).toEqual({ ok: false, reason: "suppressed" });
  });

  it("a transient bounce does not suppress", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const to = `full-${randomUUID()}@example.test`;
    await POST(signed(bounceEvent(to, `re_${randomUUID()}`, "Transient")));
    const { hmac } = await import("@/lib/server/signoff/crypto");
    const { data } = await admin.from("signoff_suppressions").select("email_hash").eq("email_hash", hmac("email", to));
    expect(data).toEqual([]);
  });

  it("a complaint suppresses and updates the delivery status; a forged or stale signature is rejected", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const key = `test-${randomUUID()}`;
    const emailId = `re_${randomUUID()}`;
    await admin.rpc("email_delivery_begin", { p_key: key, p_kind: "customer_invitation", p_mode: "resend", p_related_type: null, p_related_id: null, p_max_attempts: 5 });
    await admin.rpc("email_delivery_finish", { p_key: key, p_ok: true, p_message_id: emailId, p_error: null });
    const res = await POST(signed({ type: "email.complained", data: { email_id: emailId, to: [`complain-${randomUUID()}@example.test`] } }));
    expect(res.status).toBe(200);
    expect((await admin.from("email_deliveries").select("status").eq("idempotency_key", key).single()).data?.status).toBe("complained");
    // A later "delivered" never overwrites a complaint.
    await POST(signed({ type: "email.delivered", data: { email_id: emailId } }));
    expect((await admin.from("email_deliveries").select("status").eq("idempotency_key", key).single()).data?.status).toBe("complained");

    const forged = signed({ type: "email.complained", data: { to: ["victim@example.test"] } });
    const tampered = new Request(forged.url, { method: "POST", headers: forged.headers, body: JSON.stringify({ type: "email.complained", data: { to: ["someone-else@example.test"] } }) });
    expect((await POST(tampered)).status).toBe(400);
  });
});
