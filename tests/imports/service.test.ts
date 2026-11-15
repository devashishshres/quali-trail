import { describe, expect, it } from "vitest";
import { applyReview, buildConfirmation, draftImport, IMPORT_BUDGET_MS, ReviewError, startImport, toView, type ImportPorts, type ImportRow } from "@/lib/server/imports/service";
import { proposeWithStub } from "@/lib/server/imports/structure-check";
import { ListingFetchError, STUB_LISTINGS } from "@/lib/server/imports/tinyfish";
import { ImportDraft, ImportView } from "@/lib/types/imports";
import { RequirementCriteria } from "@/lib/types";

const LISTING = STUB_LISTINGS["/hvac-tech"];
const parse = (d: unknown) => ImportDraft.parse(d);

/** In-memory ports that mirror the database functions' state rules. */
function fakePorts(over: Partial<ImportPorts> = {}) {
  const rows = new Map<string, ImportRow>();
  const calls = { fetch: [] as { url: string; timeoutMs: number }[], propose: [] as { len: number; budget: number }[], begin: 0 };
  let clock = 1_000_000;
  let n = 0;
  const ports: ImportPorts = {
    resolve: async (h) => (h === "private.example.com" ? ["10.0.0.1"] : ["93.184.215.14"]),
    async begin(kind, url) {
      calls.begin += 1;
      if ([...rows.values()].some((r) => r.status === "fetching" && r.submitted_url === url && url)) return { ok: false, reason: "in_progress" };
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      rows.set(id, { id, worker_id: "w", source_kind: kind, submitted_url: url, status: "fetching", final_url: null, listing_title: null, content_text: null, content_truncated: false, retrieved_at: null, draft: null, draft_version: 0, warnings: [], error_code: null, error_message: null, expires_at: "2026-11-22T00:00:00Z", opportunity_id: null });
      return { ok: true, id };
    },
    async fetched(id, d) {
      const r = rows.get(id)!;
      if (r.status !== "fetching") return false;
      Object.assign(r, { status: "fetched", listing_title: d.title, final_url: d.finalUrl, content_text: d.text, content_truncated: d.truncated, retrieved_at: "2026-11-15T00:00:00Z" });
      return true;
    },
    async fail(id, code, message) {
      const r = rows.get(id)!;
      if (r.status === "fetching" || r.status === "drafting") Object.assign(r, { status: "failed", error_code: code, error_message: message });
    },
    async lease(id) {
      const r = rows.get(id)!;
      const ok = !!r.content_text && (r.status === "fetched" || (r.status === "failed" && !!r.error_code?.startsWith("draft_")));
      if (ok) Object.assign(r, { status: "drafting", error_code: null, error_message: null });
      return ok;
    },
    async load(id) {
      return rows.get(id) ?? null;
    },
    async drafted(id, draft, warnings) {
      const r = rows.get(id)!;
      if (r.status !== "drafting") return null;
      Object.assign(r, { status: "drafted", draft, warnings, draft_version: r.draft_version + 1 });
      return r.draft_version;
    },
    async fetchListing(url, timeoutMs) {
      calls.fetch.push({ url, timeoutMs });
      return { title: LISTING.title, finalUrl: url, text: LISTING.text, requestId: "r" };
    },
    async propose(text, budget) {
      calls.propose.push({ len: text.length, budget });
      return proposeWithStub(text);
    },
    now: () => clock,
    ...over,
  };
  return { ports, rows, calls, tick: (ms: number) => (clock += ms) };
}

describe("startImport", () => {
  it("retrieves, drafts and returns a reviewable draft with assessment previews", async () => {
    const { ports, calls } = fakePorts();
    const out = await startImport(ports, { url: "https://jobs.example.com/hvac-tech" });
    expect(out.kind).toBe("done");
    const row = (out as { row: ImportRow }).row;
    expect(row.status).toBe("drafted");
    expect(calls.fetch).toEqual([{ url: "https://jobs.example.com/hvac-tech", timeoutMs: 45_000 }]);
    expect(calls.propose[0].budget).toBeLessThanOrEqual(IMPORT_BUDGET_MS);
    const view = toView(row, parse);
    expect(ImportView.safeParse(view).success).toBe(true);
    const kinds = Object.values(view.previews).map((p) => p.kind);
    expect(kinds).toEqual(["supported", "supported", "review_only", "review_only", "supported", "supported"]);
  });

  it("a non-public URL is refused before any row or provider call", async () => {
    const { ports, calls } = fakePorts();
    for (const u of ["http://169.254.169.254/latest", "https://private.example.com/x", "http://localhost:3000/"]) {
      expect((await startImport(ports, { url: u })).kind).toBe("rejected");
    }
    expect(calls.begin).toBe(0);
    expect(calls.fetch).toHaveLength(0);
  });

  it("a result whose final URL is not public is discarded", async () => {
    const { ports, calls } = fakePorts({ fetchListing: async () => ({ title: "x", finalUrl: "http://10.0.0.7/admin", text: "secret", requestId: null }) });
    const out = (await startImport(ports, { url: "https://jobs.example.com/hvac-tech" })) as { row: ImportRow };
    expect(out.row.status).toBe("failed");
    expect(out.row.error_code).toBe("fetch_final_url");
    expect(out.row.content_text).toBeNull();
    expect(calls.propose).toHaveLength(0);
  });

  it("a provider failure is recorded with a retryable flag and no model call", async () => {
    const { ports, calls } = fakePorts({ fetchListing: async () => Promise.reject(new ListingFetchError("bot_blocked" as never, "blocked", false)) });
    const out = (await startImport(ports, { url: "https://jobs.example.com/hvac-tech" })) as { row: ImportRow };
    expect(out.row.status).toBe("failed");
    expect(toView(out.row, parse).error?.retryable).toBe(false);
    expect(calls.propose).toHaveLength(0);
  });

  it("drafting is skipped (and recorded) when the fetch used up the budget", async () => {
    const f = fakePorts();
    let fetches = 0;
    f.ports.fetchListing = async (url) => {
      fetches += 1;
      f.tick(IMPORT_BUDGET_MS - 5_000);
      return { title: null, finalUrl: url, text: LISTING.text, requestId: null };
    };
    const out = (await startImport(f.ports, { url: "https://jobs.example.com/hvac-tech" })) as { row: ImportRow };
    expect(out.row.status).toBe("failed");
    expect(out.row.error_code).toBe("draft_timeout");
    expect(f.calls.propose).toHaveLength(0);
    // The stored listing allows a retry later without another retrieval.
    f.tick(0);
    const retried = await draftImport(f.ports, out.row.id);
    expect(retried.status).toBe("drafted");
    expect(fetches).toBe(1);
  });

  it("pasted text never calls the listing provider", async () => {
    const { ports, calls } = fakePorts();
    const out = (await startImport(ports, { text: LISTING.text })) as { row: ImportRow };
    expect(out.row.status).toBe("drafted");
    expect(calls.fetch).toHaveLength(0);
    expect(out.row.warnings.join(" ")).toMatch(/supplied by you/);
  });
});

describe("duplicate provider calls", () => {
  it("a second draft request for a drafted import makes no model call and changes nothing", async () => {
    const { ports, calls } = fakePorts();
    const { row } = (await startImport(ports, { url: "https://jobs.example.com/hvac-tech" })) as { row: ImportRow };
    const before = JSON.stringify(row.draft);
    await Promise.all([draftImport(ports, row.id), draftImport(ports, row.id)]);
    expect(calls.propose).toHaveLength(1);
    expect(JSON.stringify((await ports.load(row.id))!.draft)).toBe(before);
  });
});

describe("review edits and confirmation", () => {
  async function drafted() {
    const f = fakePorts();
    const { row } = (await startImport(f.ports, { url: "https://jobs.example.com/hvac-tech" })) as { row: ImportRow };
    return { row, draft: parse(row.draft) };
  }

  it("edits never change the original wording; wording edits are cosmetic and rules ignore them", async () => {
    const { row, draft } = await drafted();
    const edited = applyReview(draft, {
      version: 1,
      title: draft.title,
      employer: draft.employer,
      location: draft.location,
      lines: draft.lines.map((l, i) => ({ key: l.key, priority: l.priority, displayText: i === 0 ? "3 years of experience" : l.originalText, removed: i === 5, manualReview: i === 1 })),
    });
    expect(edited.lines.map((l) => l.originalText)).toEqual(draft.lines.map((l) => l.originalText));
    expect(edited.lines[0].displayText).toBe("3 years of experience");
    expect(edited.lines[2].displayText).toBeNull(); // unchanged wording is not an edit

    const p = buildConfirmation(row, edited, "2026-11-15");
    expect(p.requirements).toHaveLength(5);
    expect(p.opportunity.removed_count).toBe(1);
    expect(p.opportunity.edited_count).toBe(1);
    // Line 0 is EPA 608 Type II: still a supported rule, built from the ORIGINAL text despite the display edit.
    const c0 = RequirementCriteria.parse(p.requirements[0].criteria_json);
    expect(c0.rule?.kind).toBe("supported");
    expect(p.requirements[0].original_text).toBe("EPA 608 Type II or Universal certification");
    // Line 1 marked for manual review: always cannot_assess.
    expect(RequirementCriteria.parse(p.requirements[1].criteria_json).rule?.kind).toBe("review_only");
    // Original priority preserved next to the current one.
    expect(p.requirements.map((r) => r.original_priority)).toEqual(["required", "required", "required", "required", "preferred"]);
  });

  it("refuses a mismatched line set and an empty job", async () => {
    const { row, draft } = await drafted();
    expect(() => applyReview(draft, { version: 1, title: "t", employer: "e", location: null, lines: [] })).toThrow(ReviewError);
    const allRemoved = { ...draft, lines: draft.lines.map((l) => ({ ...l, removed: true })) };
    expect(() => buildConfirmation(row, allRemoved, "2026-11-15")).toThrow(/at least one/);
  });
});
