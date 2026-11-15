import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/auth", () => ({ getAuthedContext: async () => ({ worker: { id: "w-1", name: "Test Worker" } }) }));

const cwd = process.cwd();
describe("worker simulated outbox", () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "outbox-route-"));
    await mkdir(join(dir, ".signoff-outbox"));
    const line = (o: object) => JSON.stringify({ simulated: true, at: new Date().toISOString(), ...o });
    await writeFile(
      join(dir, ".signoff-outbox/outbox.jsonl"),
      [
        line({ to: "casey@example.test", subject: "[SIMULATED] invite", text: "Open http://localhost:3000/signoff#t=" + "a".repeat(43), meta: { kind: "customer_invitation", workerId: "w-1" } }),
        line({ to: "casey@example.test", subject: "[SIMULATED] code", text: "Your code is: 482913", meta: { kind: "customer_code", workerId: "w-1" } }),
        line({ to: "other@example.test", subject: "other worker", text: "x", meta: { kind: "customer_invitation", workerId: "w-2" } }),
      ].join("\n") + "\n",
    );
    process.chdir(dir);
    process.env.SIGNOFF_MAIL_MODE = "mock";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"; // simulated email requires an isolated local setup
  });
  afterAll(() => process.chdir(cwd));

  it("shows only this worker's invitations, never a code, link or address", async () => {
    const { GET } = await import("@/app/api/signoff/outbox/route");
    const body = await (await GET()).json();
    const text = JSON.stringify(body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].kind).toBe("customer_invitation");
    expect(text).not.toContain("482913");
    expect(text).not.toContain("#t=");
    expect(text).not.toContain("casey@");
    expect(text).not.toContain("other worker");
  });
});
