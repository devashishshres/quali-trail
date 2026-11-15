import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readWorkerSummary } from "@/lib/server/profile";

/** Minimal stand-in for the Supabase query builder used by readWorkerSummary. */
const client = (result: { data: unknown; error: unknown }) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }) as never;

describe("readWorkerSummary", () => {
  it("returns the trimmed summary", async () => {
    expect(await readWorkerSummary(client({ data: { summary: "  Fictional tech.  " }, error: null }), "w")).toBe("Fictional tech.");
  });

  it("returns null when none is set", async () => {
    expect(await readWorkerSummary(client({ data: { summary: null }, error: null }), "w")).toBeNull();
    expect(await readWorkerSummary(client({ data: { summary: "   " }, error: null }), "w")).toBeNull();
    expect(await readWorkerSummary(client({ data: null, error: null }), "w")).toBeNull();
  });

  it("returns null, not an error, when the column does not exist yet (migration not applied)", async () => {
    expect(await readWorkerSummary(client({ data: null, error: { code: "42703", message: "column workers.summary does not exist" } }), "w")).toBeNull();
  });
});
