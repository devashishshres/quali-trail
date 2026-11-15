/**
 * Turns a model PROPOSAL into a draft the technician reviews. PURE: no I/O.
 *
 * Nothing the model writes is trusted as content:
 *  - A requirement line is kept only if it appears word-for-word in the listing (whitespace, bullets, quote and
 *    dash styles aside). Lines that fail are dropped and counted, and the draft says so prominently.
 *  - Priority is read from the listing itself (its section heading or the line's own wording), never from the
 *    model. When the listing doesn't say, it is "unspecified".
 *  - Title, employer and location are kept only when they appear in the listing (or the page title).
 */
import type { RequirementPriority } from "@/lib/types";
import type { ImportDraft, ImportLine } from "@/lib/types/imports";

export interface ModelProposal {
  title: string | null;
  employer: string | null;
  location: string | null;
  requirements: { text: string; category: string | null }[];
  incomplete: boolean;
}

export const MAX_LINES = 40;
/** Characters of listing text sent to the model. Longer listings are cut and the draft is flagged. */
export const MODEL_INPUT_LIMIT = 30_000;
/** Characters of listing text stored for drafting. */
export const STORE_LIMIT = 60_000;

/** Comparable form: lower case, single spaces, plain quotes and dashes, no markdown emphasis or bullets. */
export function canon(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:[-*•·▪◦‣+]|\d{1,2}[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The model's line, cleaned the same way, without trailing punctuation. */
function lineKey(s: string) {
  return canon(s).replace(/[.;:,]+$/, "").trim();
}

const PREFERRED_HEADING = /\b(?:preferred|nice to have|bonus|desired|pluses|a plus|ideal|desirable|optional)\b/;
const REQUIRED_HEADING = /\b(?:requirements?|required|qualifications?|must haves?|minimum|basic|essential|what you need|what you'll need|what we need)\b/;
const OTHER_HEADING = /\b(?:benefits?|perks|about|responsibilit(?:y|ies)|duties|what you'll do|compensation|pay|salary|schedule|how to apply|equal opportunity)\b/;

function isHeading(raw: string): string | null {
  const t = raw.trim();
  const md = t.match(/^#{1,6}\s+(.+)$/);
  if (md) return md[1];
  const bold = t.match(/^\*\*([^*]{2,80})\*\*:?$/);
  if (bold) return bold[1];
  if (/^[A-Za-z][A-Za-z '’&/-]{1,60}:$/.test(t)) return t.slice(0, -1);
  return null;
}

interface SourceLine {
  text: string; // canon
  raw: string;
  heading: string | null; // canon heading in force
}

function sourceLines(source: string): SourceLine[] {
  let heading: string | null = null;
  const out: SourceLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const h = isHeading(raw);
    if (h) {
      heading = canon(h);
      continue;
    }
    if (raw.trim()) out.push({ text: canon(raw), raw: raw.trim(), heading });
  }
  return out;
}

export function priorityFor(lineText: string, heading: string | null): RequirementPriority {
  const t = canon(lineText);
  if (/\b(?:preferred|a plus|is a plus|nice to have|bonus|desired|ideally)\b/.test(t)) return "preferred";
  if (/\b(?:required|must|mandatory)\b/.test(t)) return "required";
  if (heading) {
    if (PREFERRED_HEADING.test(heading)) return "preferred";
    if (OTHER_HEADING.test(heading)) return "unspecified";
    if (REQUIRED_HEADING.test(heading)) return "required";
  }
  return "unspecified";
}

/** Appears in the listing (or equals the page title)? Returns the listing's own wording when found. */
function verbatim(value: string | null, source: string, pageTitle: string | null): string | null {
  if (!value) return null;
  const v = canon(value);
  if (v.length < 2) return null;
  if (pageTitle && canon(pageTitle).includes(v)) return value.trim().slice(0, 300);
  return canon(source).includes(v) ? value.trim().slice(0, 300) : null;
}

export interface CheckResult {
  draft: ImportDraft;
  warnings: string[];
}

export function buildDraft(
  proposal: ModelProposal,
  source: { text: string; pageTitle: string | null; sentTruncated: boolean; storedTruncated: boolean; kind: "listing_url" | "pasted_text" },
): CheckResult {
  const lines = sourceLines(source.text);
  const seen = new Set<string>();
  const kept: ImportLine[] = [];
  let failed = 0;
  let overflow = 0;

  for (const r of proposal.requirements) {
    const key = lineKey(r.text ?? "");
    if (key.length < 3) {
      failed += 1;
      continue;
    }
    if (seen.has(key)) continue;
    // Find the listing line that contains it, word for word.
    const at = lines.find((l) => l.text.includes(key));
    if (!at) {
      failed += 1;
      continue;
    }
    seen.add(key);
    if (kept.length >= MAX_LINES) {
      overflow += 1;
      continue;
    }
    // Keep the listing's own characters for the line, not the model's.
    const start = at.text.indexOf(key);
    const original = recoverOriginal(at.raw, start, key.length) ?? r.text.trim();
    const priority = priorityFor(at.raw, at.heading);
    kept.push({
      key: `l${kept.length + 1}`,
      originalText: original.slice(0, 1000),
      sourceExcerpt: (at.heading ? `${at.heading}: ${at.raw}` : at.raw).slice(0, 2000),
      originalPriority: priority,
      priority,
      category: r.category ? r.category.slice(0, 60) : null,
      displayText: null,
      removed: false,
      manualReview: false,
    });
  }

  const title = verbatim(proposal.title, source.text, source.pageTitle) ?? source.pageTitle?.slice(0, 300) ?? "Imported job (title not stated)";
  const employer = verbatim(proposal.employer, source.text, source.pageTitle) ?? "Employer not stated";
  const location = verbatim(proposal.location, source.text, null);

  const warnings: string[] = [];
  if (source.storedTruncated || source.sentTruncated) warnings.push("The listing was longer than QualiTrail reads, so its end was cut off. Requirements near the end may be missing.");
  if (failed > 0) warnings.push(`${failed} line${failed > 1 ? "s" : ""} proposed from the listing could not be found word-for-word in it and ${failed > 1 ? "were" : "was"} left out. Check the listing for requirements that are missing below.`);
  if (overflow > 0) warnings.push(`Only the first ${MAX_LINES} requirements were kept; ${overflow} more were left out.`);
  if (proposal.incomplete) warnings.push("The listing looked incomplete (for example cut off, or requirements in an image or attachment). Compare it with the original before confirming.");
  if (kept.length === 0) warnings.push("No requirement lines were found. The page may not contain the listing text; try pasting it instead.");
  if (source.kind === "pasted_text") warnings.push("This listing text was supplied by you, not retrieved from the employer's page.");

  return {
    draft: {
      title,
      employer,
      location,
      description: "Requirements below are quoted word-for-word from the listing.",
      lines: kept,
      failedLines: failed,
      modelIncomplete: proposal.incomplete,
    },
    warnings,
  };
}

/** Map a span in canon(raw) back to raw characters (canon only removes/collapses, so walk both). */
function recoverOriginal(raw: string, canonStart: number, canonLen: number): string | null {
  const stripped = raw.replace(/^\s*(?:[-*•·▪◦‣+]|\d{1,2}[.)])\s+/, "").replace(/\*\*|__|`/g, "");
  if (canon(stripped).length !== canon(raw).length) return null;
  // Build index map from canon positions to stripped positions.
  const map: number[] = [];
  let out = "";
  let prevSpace = true;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      prevSpace = true;
      out += " ";
      map.push(i);
      continue;
    }
    prevSpace = false;
    out += ch;
    map.push(i);
  }
  const lead = out.length - out.trimStart().length;
  const a = map[canonStart + lead];
  const b = map[canonStart + lead + canonLen - 1];
  if (a === undefined || b === undefined) return null;
  const piece = stripped.slice(a, b + 1).trim();
  return canon(piece) === canon(stripped).slice(canonStart, canonStart + canonLen) ? piece : null;
}

/**
 * Deterministic stand-in for isolated local development: every bullet under a heading becomes a proposed line,
 * verbatim. Never used when hosted (see importConfigProblems).
 */
export function proposeWithStub(listing: string): ModelProposal {
  const lines = listing.split(/\r?\n/);
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "") ?? null;
  const employerLine = lines.find((l) => /—/.test(l) && !/^#/.test(l)) ?? null;
  const [employer, location] = employerLine ? employerLine.split("—").map((s) => s.trim()) : [null, null];
  let section = "";
  const reqs: ModelProposal["requirements"] = [];
  for (const l of lines) {
    const h = l.match(/^#{2,6}\s+(.+)/);
    if (h) section = canon(h[1]);
    else if (/^\s*[-*]\s+/.test(l) && /requirement|preferred|qualification/.test(section)) reqs.push({ text: l.replace(/^\s*[-*]\s+/, "").trim(), category: null });
  }
  return { title, employer, location: location ?? null, requirements: reqs, incomplete: false };
}
