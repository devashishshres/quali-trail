import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmac, maskEmail, newCode, newToken, normalizeEmail, safeEqual } from "@/lib/server/signoff/crypto";
import { redact } from "@/lib/server/signoff/redact";
import { mailMode, missingConfig, signoffStatus } from "@/lib/server/signoff/config";
import { verifyWebhook } from "@/lib/server/email/webhook-signature";
import { editProblem } from "@/lib/server/signoff/edit-rules";
import { signoffLabel } from "@/lib/client/signoff-labels";
import type { WorkerSignoff } from "@/lib/types";

const KEY = "k".repeat(40);

describe("crypto", () => {
  it("hashes are deterministic, purpose-separated and keyed", () => {
    expect(hmac("token", "abc", KEY)).toBe(hmac("token", "abc", KEY));
    expect(hmac("token", "abc", KEY)).not.toBe(hmac("code", "abc", KEY));
    expect(hmac("token", "abc", KEY)).not.toBe(hmac("token", "abc", "j".repeat(40)));
    expect(hmac("token", "abc", KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("tokens are long and unique; codes are 6 digits", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });
  it("masks addresses and compares in constant time", () => {
    expect(maskEmail("casey@example.com")).toBe("c***@example.com");
    expect(normalizeEmail("  Casey@Example.COM ")).toBe("casey@example.com");
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
  });
  it("refuses to run without a real pepper", async () => {
    const { pepper } = await import("@/lib/server/signoff/crypto");
    expect(() => pepper({} as NodeJS.ProcessEnv)).toThrow();
    expect(() => pepper({ SIGNOFF_PEPPER: "short" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("log redaction", () => {
  it("removes tokens, link fragments, codes and full addresses", () => {
    const token = newToken();
    const out = redact(`failed for casey.customer@example.com link https://x.test/signoff#t=${token} code 123456 raw ${token}`);
    expect(out).not.toContain(token);
    expect(out).not.toContain("casey.customer");
    expect(out).not.toContain("123456");
    expect(out).toContain("[email]");
  });
});

describe("configuration gating", () => {
  it("defaults to off and never reports ready without full configuration", () => {
    expect(mailMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(signoffStatus({ SIGNOFF_ENABLED: "true" } as unknown as NodeJS.ProcessEnv).ready).toBe(false);
    const mock = { SIGNOFF_ENABLED: "true", SIGNOFF_MAIL_MODE: "mock", SIGNOFF_PEPPER: KEY, APP_BASE_URL: "http://localhost:3000" } as unknown as NodeJS.ProcessEnv;
    expect(signoffStatus(mock)).toMatchObject({ ready: true, mode: "mock" });
    const resend = { ...mock, SIGNOFF_MAIL_MODE: "resend" } as NodeJS.ProcessEnv;
    expect(missingConfig(resend)).toEqual(["RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET"]);
    expect(signoffStatus(resend).ready).toBe(false);
    expect(signoffStatus({ ...mock, SIGNOFF_ENABLED: "false" } as NodeJS.ProcessEnv).enabled).toBe(false);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_" + Buffer.from("super-secret-key-material").toString("base64");
  const sign = (id: string, ts: string, body: string) =>
    "v1," + createHmac("sha256", Buffer.from("super-secret-key-material")).update(`${id}.${ts}.${body}`).digest("base64");
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it("accepts a valid signature and rejects tampering, stale timestamps and missing headers", () => {
    const body = '{"type":"email.bounced"}';
    const sig = sign("msg_1", ts, body);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: sig }, body, now)).toBe(true);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sig}` }, body, now)).toBe(true);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: sig }, body + " ", now)).toBe(false);
    expect(verifyWebhook(secret, { id: "msg_2", timestamp: ts, signature: sig }, body, now)).toBe(false);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: String(now / 1000 - 1000), signature: sign("msg_1", String(now / 1000 - 1000), body) }, body, now)).toBe(false);
    expect(verifyWebhook(secret, { id: null, timestamp: ts, signature: sig }, body, now)).toBe(false);
    expect(verifyWebhook("whsec_" + Buffer.from("other").toString("base64"), { id: "msg_1", timestamp: ts, signature: sig }, body, now)).toBe(false);
  });
});

describe("edit eligibility (Phase 1)", () => {
  it("allows work records and checklists that are self-reported or document-supplied", () => {
    expect(editProblem({ type: "work_record", verificationStatus: "self_reported" }, "work_record")).toBeNull();
    expect(editProblem({ type: "checklist", verificationStatus: "document_supplied" }, "checklist")).toBeNull();
  });
  it("refuses certifications and training, type changes and anything past self-report/supplied", () => {
    expect(editProblem({ type: "certification", verificationStatus: "self_reported" }, "certification")).toBe("unsupported_type");
    expect(editProblem({ type: "training", verificationStatus: "self_reported" }, "training")).toBe("unsupported_type");
    expect(editProblem({ type: "work_record", verificationStatus: "self_reported" }, "checklist")).toBe("type_change");
    for (const s of ["independently_confirmed", "pending_review", "expired_or_invalid"] as const) {
      expect(editProblem({ type: "work_record", verificationStatus: s }, "work_record")).toBe("not_editable");
    }
  });
});

describe("acknowledgment labels", () => {
  const base: WorkerSignoff = {
    id: "00000000-0000-4000-8000-000000000001", evidenceId: "00000000-0000-4000-8000-000000000002", evidenceVersion: 1, status: "acknowledged",
    emailHint: "c***@x.test", deliveryMode: "resend", createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z",
    emailVerifiedAt: "2026-11-02T00:00:00Z", decision: "confirm", decidedAt: "2026-11-02T10:00:00Z", typedName: "Casey Customer", comment: null,
  };
  it("a real acknowledgment says exactly what was and was not established", () => {
    const l = signoffLabel(base, 1);
    expect(l.long).toMatch(/A code sent to the email address the worker provided was entered/);
    expect(l.long).toMatch(/Neither the customer's identity nor the work is independently verified/);
    expect(l.long).not.toMatch(/independently confirmed/i);
  });
  it("simulated delivery is never described as email verification", () => {
    const l = signoffLabel({ ...base, deliveryMode: "mock" }, 1);
    expect(l.long).toMatch(/Simulated \(no real email was sent\)/);
    expect(l.long).not.toMatch(/A code sent to the email address/);
    expect(l.tone).toBe("simulated");
  });
  it("flags a record that changed after it was acknowledged", () => {
    expect(signoffLabel(base, 2).short).toBe("Changed since acknowledged");
  });
  it("other states use plain labels", () => {
    expect(signoffLabel({ ...base, status: "pending", decision: null }, 1).short).toBe("Awaiting customer");
    expect(signoffLabel({ ...base, status: "correction_requested" }, 1).short).toBe("Correction requested");
    expect(signoffLabel({ ...base, status: "declined" }, 1).short).toBe("Declined");
  });
});
