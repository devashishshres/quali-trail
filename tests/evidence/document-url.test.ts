import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

// GET /api/evidence/:id with a fake signed-in context and storage.
const state = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, signed: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/server/memory/indexing", () => ({ reconcileIndexing: async (_a: unknown, _u: unknown, _w: string, rows: unknown[]) => rows }));
vi.mock("@/lib/api/auth", () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: state.row, error: null }) };
  return {
    getAuthedContext: async () => ({
      authUserId: "u0000000-0000-4000-8000-000000000001",
      worker: { id: "a0000000-0000-4000-8000-000000000001" },
      supabase: { from: () => query, storage: { from: () => ({ createSignedUrl: async () => state.signed }) } },
    }),
  };
});
import { GET } from "@/app/api/evidence/[id]/route";

const ID = "e0000000-0000-4000-8000-000000000001";
const row = (storage_path: string | null) => ({
  id: ID, worker_id: "a0000000-0000-4000-8000-000000000001", type: "training", title: "Fictional training",
  source_date: null, issuer: null, structured_data: {}, source_kind: "pdf_upload", storage_path,
  verification_status: "document_supplied", index_status: "indexed", index_error: null, is_synthetic: true,
  version: 1, created_at: "2026-11-14T17:00:00.000+00:00", updated_at: "2026-11-14T17:00:00.000+00:00",
});
const get = () => GET(new Request(`http://test/api/evidence/${ID}`), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  state.row = null;
  state.signed = null;
});

it("returns a short-lived URL when the original can be signed", async () => {
  state.row = row("u0000000-0000-4000-8000-000000000001/doc.pdf");
  state.signed = { data: { signedUrl: "https://storage.test/signed" }, error: null };
  const res = await get();
  expect(res.status).toBe(200);
  expect((await res.json()).documentUrl).toBe("https://storage.test/signed");
});

it("reports a signing failure as an error, not as 'no original file'", async () => {
  state.row = row("u0000000-0000-4000-8000-000000000001/doc.pdf");
  state.signed = { data: null, error: { message: "Object not found" } };
  const res = await get();
  expect(res.status).toBe(500);
  expect((await res.json()).error.code).toBe("internal");
});

it("returns documentUrl null only when the record has no original", async () => {
  state.row = row(null);
  const res = await get();
  expect(res.status).toBe(200);
  expect((await res.json()).documentUrl).toBeNull();
});
