/**
 * Job-import orchestration. PURE w.r.t. infrastructure: database calls, the listing fetcher, the model, DNS and
 * the clock come in as ports, so deadlines, duplicate calls and failures are unit-testable.
 *
 * Sequence (one request; nothing about the technician leaves QualiTrail):
 *   1. check the URL (syntax + DNS: public addresses only)        no row, no provider call if it fails
 *   2. begin        -> row 'fetching' (unique per URL; daily limit)  duplicate submit -> "in progress"
 *   3. fetch        -> TinyFish, listing URL only, hard deadline
 *   4. check final  -> final_url must be public, else the result is discarded
 *   5. fetched      -> listing text stored (public posting only)
 *   6. lease        -> exactly one drafter; a drafted/confirmed draft is never regenerated
 *   7. propose      -> Gemini, listing text only, within the remaining budget
 *   8. drafted      -> verbatim-checked draft + completeness warnings
 *
 * Overall budget IMPORT_BUDGET_MS (100 s) is enforced here, well inside Vercel's 300 s default function limit,
 * and does not rely on maxDuration. TinyFish's own per-request ceiling is 120 s; we never wait that long.
 */
import type { ImportDraft, ImportView, LineAssessmentPreview, SaveImportReviewRequest } from "@/lib/types/imports";
import type { RequirementCriteria } from "@/lib/types";
import { analyzeRequirement, REVIEW_REASON_TEXT } from "../opportunities/requirement-rules";
import { buildDraft, canon, MODEL_INPUT_LIMIT, STORE_LIMIT, type ModelProposal } from "./structure-check";
import type { FetchedListing } from "./tinyfish";
import { ListingFetchError } from "./tinyfish";
import { checkPublicUrl, type Resolver } from "./url";

export const IMPORT_BUDGET_MS = 100_000;
export const FETCH_MAX_MS = 45_000;
/** Minimum time a drafting attempt needs (one model attempt). */
export const DRAFT_MIN_MS = 15_000;
const SAFETY_MS = 2_000;

export interface ImportRow {
  id: string;
  worker_id: string;
  source_kind: "listing_url" | "pasted_text";
  submitted_url: string | null;
  status: ImportView["status"];
  final_url: string | null;
  listing_title: string | null;
  content_text: string | null;
  content_truncated: boolean;
  retrieved_at: string | null;
  draft: unknown;
  draft_version: number;
  warnings: string[];
  error_code: string | null;
  error_message: string | null;
  expires_at: string;
  opportunity_id: string | null;
}

export interface ImportPorts {
  resolve: Resolver;
  begin(kind: "listing_url" | "pasted_text", url: string | null): Promise<{ ok: true; id: string } | { ok: false; reason: "in_progress" | "daily_limit" | "not_found" | "error" }>;
  fetched(id: string, d: { title: string | null; finalUrl: string | null; text: string; truncated: boolean; requestId: string | null }): Promise<boolean>;
  fail(id: string, code: string, message: string): Promise<void>;
  lease(id: string): Promise<boolean>;
  load(id: string): Promise<ImportRow | null>;
  drafted(id: string, draft: ImportDraft, warnings: string[]): Promise<number | null>;
  fetchListing(url: string, timeoutMs: number): Promise<FetchedListing>;
  propose(listing: string, budgetMs: number): Promise<ModelProposal>;
  now(): number;
}

export type StartOutcome =
  | { kind: "rejected"; message: string }
  | { kind: "busy"; reason: "in_progress" | "daily_limit" }
  | { kind: "done"; row: ImportRow };

const RETRYABLE_FETCH = new Set(["fetch_timeout", "fetch_unreachable", "fetch_provider_unavailable", "abandoned"]);

export async function startImport(ports: ImportPorts, input: { url: string } | { text: string }): Promise<StartOutcome> {
  const deadline = ports.now() + IMPORT_BUDGET_MS;

  if ("text" in input) {
    const b = await ports.begin("pasted_text", null);
    if (!b.ok) return b.reason === "in_progress" || b.reason === "daily_limit" ? { kind: "busy", reason: b.reason } : { kind: "rejected", message: "The import couldn't start. Try again." };
    const text = input.text.slice(0, STORE_LIMIT);
    await ports.fetched(b.id, { title: null, finalUrl: null, text, truncated: input.text.length > STORE_LIMIT, requestId: null });
    return { kind: "done", row: await draftImport(ports, b.id, deadline) };
  }

  const checked = await checkPublicUrl(input.url, ports.resolve);
  if (!checked.ok) return { kind: "rejected", message: checked.reason };

  const b = await ports.begin("listing_url", checked.url);
  if (!b.ok) return b.reason === "in_progress" || b.reason === "daily_limit" ? { kind: "busy", reason: b.reason } : { kind: "rejected", message: "The import couldn't start. Try again." };

  let listing: FetchedListing;
  try {
    const timeoutMs = Math.min(FETCH_MAX_MS, deadline - ports.now() - DRAFT_MIN_MS - SAFETY_MS);
    listing = await ports.fetchListing(checked.url, timeoutMs);
  } catch (e) {
    const err = e instanceof ListingFetchError ? e : new ListingFetchError("provider_unavailable", "The listing couldn't be retrieved.", true);
    await ports.fail(b.id, `fetch_${err.code}`, err.message);
    return { kind: "done", row: (await ports.load(b.id))! };
  }

  // Last line: a result whose final address is not a public web page is discarded (see url.ts for the boundary).
  const final = await checkPublicUrl(listing.finalUrl, ports.resolve);
  if (!final.ok) {
    await ports.fail(b.id, "fetch_final_url", "The listing redirected to an address that isn't a public web page, so the result was discarded.");
    return { kind: "done", row: (await ports.load(b.id))! };
  }

  await ports.fetched(b.id, {
    title: listing.title,
    finalUrl: final.url,
    text: listing.text.slice(0, STORE_LIMIT),
    truncated: listing.text.length > STORE_LIMIT,
    requestId: listing.requestId,
  });
  return { kind: "done", row: await draftImport(ports, b.id, deadline) };
}

/** Generate the draft once. A concurrent or repeated call returns the row as it is, without a model call. */
export async function draftImport(ports: ImportPorts, id: string, deadline = ports.now() + IMPORT_BUDGET_MS): Promise<ImportRow> {
  if (!(await ports.lease(id))) return (await ports.load(id))!;
  const row = (await ports.load(id))!;
  try {
    const budget = deadline - ports.now() - SAFETY_MS;
    if (budget < DRAFT_MIN_MS) throw new DraftBudgetError();
    const text = row.content_text ?? "";
    const proposal = await ports.propose(text.slice(0, MODEL_INPUT_LIMIT), budget);
    const { draft, warnings } = buildDraft(proposal, {
      text,
      pageTitle: row.listing_title,
      sentTruncated: text.length > MODEL_INPUT_LIMIT,
      storedTruncated: row.content_truncated,
      kind: row.source_kind,
    });
    if (row.submitted_url && row.final_url && hostOf(row.submitted_url) !== hostOf(row.final_url)) {
      warnings.push(`The link led to a different website (${hostOf(row.final_url)}). Check that this is the listing you meant.`);
    }
    await ports.drafted(id, draft, warnings);
  } catch (e) {
    const code = e instanceof DraftBudgetError ? "draft_timeout" : ((e as { code?: string }).code ?? "draft_model_failed");
    const message = e instanceof DraftBudgetError ? "There wasn't enough time left to draft the requirements. Try again." : e instanceof Error ? e.message : "Drafting failed.";
    await ports.fail(id, code.startsWith("draft_") ? code : "draft_model_failed", message);
  }
  return (await ports.load(id))!;
}

class DraftBudgetError extends Error {}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/* ------------------------------------------------------------------ */
/* Views, review edits, confirmation (pure)                            */
/* ------------------------------------------------------------------ */

export function previewFor(originalText: string, manualReview: boolean): LineAssessmentPreview {
  const { rule } = analyzeRequirement(originalText, { manualReview });
  return rule.kind === "supported"
    ? { kind: "supported", conditions: rule.conditions.map((c) => c.label) }
    : { kind: "review_only", reasons: rule.reasons, reasonText: rule.reasons.map((r) => REVIEW_REASON_TEXT[r]) };
}

export function toView(row: ImportRow, parseDraft: (d: unknown) => ImportDraft | null): ImportView {
  const draft = row.draft ? parseDraft(row.draft) : null;
  return {
    id: row.id,
    status: row.status,
    sourceKind: row.source_kind,
    submittedUrl: row.submitted_url,
    finalUrl: row.final_url,
    retrievedAt: row.retrieved_at,
    warnings: row.warnings ?? [],
    error: row.error_code
      ? { code: row.error_code, message: row.error_message ?? "The import didn't finish.", retryable: row.error_code.startsWith("draft_") || RETRYABLE_FETCH.has(row.error_code) }
      : null,
    version: row.draft_version,
    draft,
    previews: Object.fromEntries((draft?.lines ?? []).map((l) => [l.key, previewFor(l.originalText, l.manualReview)])),
    expiresAt: row.expires_at,
    opportunityId: row.opportunity_id,
  };
}

export class ReviewError extends Error {}

/** Apply the technician's edits. The ORIGINAL wording, excerpt and original priority are never changed. */
export function applyReview(draft: ImportDraft, edit: SaveImportReviewRequest): ImportDraft {
  const byKey = new Map(edit.lines.map((l) => [l.key, l]));
  if (byKey.size !== edit.lines.length || edit.lines.length !== draft.lines.length || !draft.lines.every((l) => byKey.has(l.key))) {
    throw new ReviewError("The requirement list changed. Reload the draft and try again.");
  }
  return {
    ...draft,
    title: edit.title,
    employer: edit.employer,
    location: edit.location?.trim() ? edit.location.trim() : null,
    lines: draft.lines.map((l) => {
      const e = byKey.get(l.key)!;
      const shown = e.displayText?.trim() ?? "";
      return {
        ...l,
        priority: e.priority,
        removed: e.removed,
        manualReview: e.manualReview,
        // Unchanged or blank wording is not an edit.
        displayText: shown && canon(shown) !== canon(l.originalText) ? shown.slice(0, 1000) : null,
      };
    }),
  };
}

export interface ConfirmationPayload {
  opportunity: { title: string; employer: string; description: string; location: string | null; warnings: string[]; removed_count: number; edited_count: number };
  requirements: {
    position: number;
    original_text: string;
    criteria_json: RequirementCriteria;
    mandatory: boolean;
    source: string;
    priority: string;
    original_priority: string;
    display_text: string | null;
    source_excerpt: string | null;
    category: string | null;
  }[];
}

/** Rules are built here, on the server, from each line's ORIGINAL wording. */
export function buildConfirmation(row: ImportRow, draft: ImportDraft, retrievedOn: string): ConfirmationPayload {
  const kept = draft.lines.filter((l) => !l.removed);
  if (kept.length === 0) throw new ReviewError("Keep at least one requirement to compare against.");
  const source = row.source_kind === "listing_url" ? `Job listing retrieved ${retrievedOn}` : "Job listing text you supplied";
  return {
    opportunity: {
      title: draft.title,
      employer: draft.employer,
      description: draft.description,
      location: draft.location,
      warnings: row.warnings ?? [],
      removed_count: draft.lines.length - kept.length,
      edited_count: kept.filter((l) => l.displayText !== null).length,
    },
    requirements: kept.map((l, i) => ({
      position: i,
      original_text: l.originalText,
      criteria_json: analyzeRequirement(l.originalText, { manualReview: l.manualReview }).criteria,
      mandatory: l.priority !== "preferred",
      source,
      priority: l.priority,
      original_priority: l.originalPriority,
      display_text: l.displayText,
      source_excerpt: l.sourceExcerpt,
      category: l.category,
    })),
  };
}
