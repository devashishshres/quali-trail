/**
 * "Your next steps": deterministic guidance derived from a SAVED requirement result. Pure, shared by server and
 * browser. No model call, no course search, no prediction. It reads only what the evaluator already stored:
 * the assessment, the linked records and the gap messages below.
 *
 * Gap messages are fixed templates. The evaluator (lib/server/matching/evaluate.ts) writes them through the
 * builders here, and they are unchanged since the first release, so results saved before this module existed
 * produce the same guidance. Multi-part requirements prefix each message with "<part label>: ".
 *
 * Guidance never says or implies that a person lacks a skill: a missing or incomplete record only means the
 * paperwork does not show it yet.
 */
import type { EvidenceConnection, RequirementResult } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Gap message templates (written by the evaluator)                    */
/* ------------------------------------------------------------------ */

export const GAP_NO_RECORD_PREFIX = "A record that directly documents: ";
export const GAP_CONFIRMATION = "A supporting document or independent confirmation for this record";
export const GAP_AMBIGUOUS =
  "The requirement's terms appear only in this record's summary or secondary details, not in its title, skills or activities.";

export const gapNoRecord = (what: string) => `${GAP_NO_RECORD_PREFIX}${what}`;
export const gapIncomplete = (title: string, what: string) => `"${title}" does not state ${what}.`;
export const gapAmbiguousUncertainty = (title: string) => `"${title}": ${GAP_AMBIGUOUS} Please confirm it covers the requirement.`;

/* ------------------------------------------------------------------ */
/* Guidance                                                            */
/* ------------------------------------------------------------------ */

export type NextStepKind = "upload" | "clarify" | "confirm" | "manual_review";

export interface NextStepLink {
  href: string;
  label: string;
}

export interface NextStep {
  kind: NextStepKind;
  /** The part of a multi-part requirement this step is about, or null for the whole line. */
  part: string | null;
  text: string;
  links: NextStepLink[];
}

/** Which existing confirmation flows are switched on (from /api/me). Unknown → treated as off. */
export interface ConfirmFlows {
  customerSignoff: boolean;
  supervisorReview: boolean;
}

export const NO_FLOWS: ConfirmFlows = { customerSignoff: false, supervisorReview: false };

export const NEXT_STEPS_NOTE =
  "These steps come only from what your saved records state. A missing or incomplete record says nothing about your ability. It only means the paperwork doesn't show it yet.";

export const NEXT_STEPS_TITLE: Record<NextStepKind, string> = {
  upload: "Upload a document you already hold",
  clarify: "Clarify the work details",
  confirm: "Request confirmation",
  manual_review: "Clarify manually",
};

/** Record types that have the customer sign-off and supervisor review panels (components/evidence/evidence-list.tsx). */
const CONFIRMABLE_TYPES = new Set(["work_record", "checklist"]);
/** Statuses for which those panels are shown. */
const CONFIRMABLE_STATUSES = new Set(["self_reported", "document_supplied"]);

const recordLink = (c: Pick<EvidenceConnection, "evidenceId" | "evidenceTitle">): NextStepLink => ({
  href: `/evidence#evidence-${c.evidenceId}`,
  label: `Open “${c.evidenceTitle}”`,
});
const EVIDENCE_LINK: NextStepLink = { href: "/evidence", label: "Go to My Evidence" };

/** Splits an optional "<part label>: " prefix off a message that should start with `body`. */
function partBefore(m: string, index: number): string | null | undefined {
  if (index === 0) return null;
  if (index >= 2 && m.slice(index - 2, index) === ": ") return m.slice(0, index - 2);
  return undefined; // not this template
}

const INCOMPLETE_RE = /^(?:(.*?): )?"(.*)" does not state (.*)\.$/;
const AMBIGUOUS_RE = /^(?:(.*?): )?"(.*)": The requirement's terms appear only in this record's summary/;

function confirmFlowsSentence(flows: ConfirmFlows): string {
  const parts = [flows.supervisorReview && "ask a supervisor to review it", flows.customerSignoff && "ask the customer to acknowledge it"].filter(Boolean);
  if (!parts.length) return "";
  return ` You can also ${parts.join(" or ")} from the record's page. Nothing is sent until you fill in and submit a request there.`;
}

export function nextSteps(result: RequirementResult, flows: ConfirmFlows = NO_FLOWS): NextStep[] {
  if (result.assessment === "evidence_found") return [];

  if (result.assessment === "cannot_assess") {
    const reason = result.uncertainties[0];
    return [
      {
        kind: "manual_review",
        part: null,
        text: `QualiTrail doesn't assess this requirement automatically.${reason ? ` ${reason}` : ""} Compare it with your records yourself, or ask the employer to clarify what they accept.`,
        links: [],
      },
    ];
  }

  const steps: NextStep[] = [];
  const byTitle = (title: string) =>
    result.connections.find((c) => c.evidenceTitle === title && c.role === "direct") ?? result.connections.find((c) => c.evidenceTitle === title);
  const expired = /expired or invalid/.test(result.explanation);

  for (const m of result.missingDocumentation) {
    // 1. Appropriate work, but self-reported: upload a supporting document, or request confirmation.
    if (m.endsWith(GAP_CONFIRMATION)) {
      const part = partBefore(m, m.length - GAP_CONFIRMATION.length);
      if (part !== undefined) {
        const records = result.connections.filter((c) => c.role === "direct" && c.verificationStatus === "self_reported");
        const confirmable = records.filter((c) => CONFIRMABLE_TYPES.has(c.evidenceType) && CONFIRMABLE_STATUSES.has(c.verificationStatus));
        steps.push({
          kind: "confirm",
          part,
          text:
            "A record describes this work, but it is self-reported with no supporting document. If you already hold one (such as an invoice, permit, checklist or certificate), upload it." +
            (confirmable.length ? confirmFlowsSentence(flows) : ""),
          links: records.length ? records.map(recordLink) : [EVIDENCE_LINK],
        });
        continue;
      }
    }

    // 2. No record documents it: upload one if already held.
    const i = m.indexOf(GAP_NO_RECORD_PREFIX);
    if (i >= 0) {
      const part = partBefore(m, i);
      if (part !== undefined) {
        steps.push({
          kind: "upload",
          part,
          text:
            `No saved record documents ${part ? "this part" : "this requirement"} yet. If you already hold a document that shows it (such as a certificate, card or work record), upload it in My Evidence.` +
            (expired ? " If a matching record has been renewed, upload the current version." : ""),
          links: [EVIDENCE_LINK],
        });
        continue;
      }
    }

    // 3. Right kind of record, but details are not stated: add or clarify the work performed.
    const inc = INCOMPLETE_RE.exec(m);
    if (inc) {
      const [, part = null, title, what] = inc;
      const c = byTitle(title);
      const work = !c || CONFIRMABLE_TYPES.has(c.evidenceType);
      steps.push({
        kind: "clarify",
        part,
        text: work
          ? `“${title}” doesn't state ${what}. If you did this work, edit the record to add or clarify the work performed.`
          : `“${title}” doesn't state ${what}. If the document shows it, add that detail to the record, or upload a version that states it.`,
        links: c ? [recordLink(c)] : [EVIDENCE_LINK],
      });
      continue;
    }

    // 4. A message this module does not recognise: show it as written, without interpreting it.
    steps.push({ kind: "clarify", part: null, text: `${m} If you have a record that covers this, add or update it in My Evidence.`, links: [EVIDENCE_LINK] });
  }

  // Ambiguous records (terms only in the summary) are recorded as uncertainties, not missing documentation.
  for (const u of result.uncertainties) {
    const amb = AMBIGUOUS_RE.exec(u);
    if (!amb) continue;
    const [, part = null, title] = amb;
    const c = byTitle(title);
    steps.push({
      kind: "clarify",
      part,
      text: `“${title}” mentions this only in its summary or secondary details. If you did this work, add it to the record's work performed so it is stated clearly.`,
      links: c ? [recordLink(c)] : [EVIDENCE_LINK],
    });
  }

  if (!steps.length) {
    steps.push({ kind: "upload", part: null, text: "If you already hold a document that covers this requirement, add it in My Evidence.", links: [EVIDENCE_LINK] });
  }

  // The same step for several parts of one line (e.g. installation AND startup both described by one self-reported
  // record) is shown once, naming every part it applies to.
  const merged = new Map<string, NextStep>();
  for (const s of steps) {
    const k = `${s.kind}|${s.text}|${s.links.map((l) => l.href).join(" ")}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...s });
    else if (s.part && prev.part && !prev.part.split(", ").includes(s.part)) prev.part = `${prev.part}, ${s.part}`;
    else if (!s.part || !prev.part) prev.part = null; // one of them is about the whole line
  }
  return [...merged.values()];
}
