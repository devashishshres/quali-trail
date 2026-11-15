/**
 * FIXTURE MODE ONLY (NEXT_PUBLIC_DATA_MODE=fixtures).
 *
 * In-memory stand-in for routes the backend hasn't shipped yet, built from
 * the same fictional seed data (supabase/seed/demo-data.ts) and typed with
 * the real contracts. Nothing persists: a full page reload resets it.
 * The UI shows a "Fixture mode" banner whenever this is active.
 *
 * Results mirror the expected demo outcomes documented in demo-data.ts.
 */
import type {
  ConfirmEvidenceRequest,
  Evidence,
  EvidenceConnection,
  EvidenceDraft,
  MatchRun,
  MatchRunResponse,
  Opportunity,
  RequirementResult,
} from "@/lib/types";
import {
  DEMO_EVIDENCE,
  DEMO_OPPORTUNITY,
  DEMO_REQUIREMENTS,
  DEMO_WORKER,
  REQUIREMENT_SOURCE,
} from "@/supabase/seed/demo-data";
import type { Api } from "./api";
import { ApiRequestError } from "./errors";

const SEEDED_AT = "2026-11-14T17:00:00.000+00:00";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const worker = { id: DEMO_WORKER.id, name: DEMO_WORKER.name, trade: DEMO_WORKER.trade, summary: "Fictional demo technician (sample data): residential heat-pump installation and startup, with EPA 608 certification.", isSynthetic: true };

const opportunity: Opportunity = {
  ...DEMO_OPPORTUNITY,
  isSynthetic: true,
  requirements: DEMO_REQUIREMENTS.map((r) => ({ ...r, opportunityId: DEMO_OPPORTUNITY.id, source: REQUIREMENT_SOURCE })),
};

const store = {
  revision: DEMO_EVIDENCE.length,
  evidence: DEMO_EVIDENCE.map(
    (d): Evidence => ({
      id: d.id,
      workerId: DEMO_WORKER.id,
      type: d.type,
      title: d.title,
      date: d.date,
      issuer: d.issuer,
      structuredData: d.structuredData,
      sourceKind: d.sourceKind,
      sourceAvailable: false, // ponytail: fixtures have no stored files
      verificationStatus: d.verificationStatus,
      indexStatus: "indexed",
      indexError: null,
      isSynthetic: true,
      version: 1,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    }),
  ),
  drafts: new Map<string, EvidenceDraft>(),
  runs: [] as MatchRun[],
};

const [E1, E2, E3, E4] = store.evidence;
const [R1, R2, R3, R4] = DEMO_REQUIREMENTS;

function link(
  e: Evidence,
  role: EvidenceConnection["role"],
  contribution: string,
  relevanceExplanation: string,
  memorySimilarity: number | null,
): EvidenceConnection {
  return {
    evidenceId: e.id,
    evidenceTitle: e.title,
    evidenceDate: e.date,
    evidenceType: e.type,
    evidenceIssuer: e.issuer,
    verificationStatus: e.verificationStatus,
    role,
    contribution,
    relevanceExplanation,
    memorySimilarity,
  };
}

function buildResults(): RequirementResult[] {
  const checklist = store.evidence.find((e) => e.type === "checklist" && e.indexStatus === "indexed");
  const base = (r: (typeof DEMO_REQUIREMENTS)[number]) => ({
    requirementId: r.id,
    originalText: r.originalText,
    mandatory: r.mandatory,
  });

  const r4Supporting = [
    link(E2, "supporting", "Shows startup and operational testing on a heat pump.", "Startup testing is part of commissioning, but this is not a commissioning checklist.", 0.71),
    link(E4, "supporting", "Shows airflow measurement and blower adjustment.", "Airflow verification is a commissioning step, recorded here as a separate work record.", 0.64),
  ];

  return [
    {
      ...base(R1),
      assessment: "evidence_found",
      connections: [link(E3, "direct", "Universal EPA Section 608 certification card.", "A certification document naming EPA Section 608, with an issuer stated.", 0.88)],
      explanation: "A supplied EPA Section 608 Universal certification card matches this requirement.",
      uncertainties: ["The card is a worker-supplied document and has not been independently reviewed."],
      missingDocumentation: [],
    },
    {
      ...base(R2),
      assessment: "evidence_found",
      connections: [link(E1, "direct", "Manufacturer heat-pump installation course completion.", "Training certificate from a heat-pump manufacturer, dated and with an issuer.", 0.83)],
      explanation: "A manufacturer training certificate covers heat-pump installation and startup.",
      uncertainties: [],
      missingDocumentation: [],
    },
    {
      ...base(R3),
      assessment: "needs_review",
      connections: [
        link(E2, "direct", "Describes a residential heat-pump startup and operational test.", "Hands-on startup work on a residential heat pump.", 0.79),
        link(E1, "supporting", "Training in installation and the factory startup procedure.", "Training supports, but does not replace, hands-on experience.", 0.58),
      ],
      explanation: "One startup record describes hands-on work, but it is self-reported and has no supporting document.",
      uncertainties: ["The startup record is self-reported.", "No installation work order or supervisor sign-off was found."],
      missingDocumentation: ["A signed work order or supervisor confirmation for an installation"],
    },
    checklist
      ? {
          ...base(R4),
          assessment: "evidence_found",
          connections: [
            link(checklist, "direct", "A completed heat-pump commissioning checklist.", "Checklist document of the accepted type, with a date.", 0.91),
            ...r4Supporting,
          ],
          explanation: "A completed commissioning checklist was found. Earlier startup and airflow records show related commissioning steps.",
          uncertainties: ["The checklist has not been independently reviewed."],
          missingDocumentation: [],
        }
      : {
          ...base(R4),
          assessment: "no_sufficient_evidence",
          connections: r4Supporting,
          explanation: "These records show related startup and airflow work, but no commissioning checklist was found.",
          uncertainties: ["Startup and airflow records are self-reported."],
          missingDocumentation: ["A completed commissioning checklist"],
        },
  ];
}

function respond(run: MatchRun): MatchRunResponse {
  const runs = store.runs.filter((r) => r.opportunityId === run.opportunityId);
  const prev = runs[runs.indexOf(run) - 1] ?? null;
  const changes = prev
    ? run.results.flatMap((after) => {
        const before = prev.results.find((r) => r.requirementId === after.requirementId);
        if (!before || before.assessment === after.assessment) return [];
        const had = new Set(before.connections.map((c) => c.evidenceId));
        return [
          {
            requirementId: after.requirementId,
            before: before.assessment,
            after: after.assessment,
            addedEvidenceIds: after.connections.map((c) => c.evidenceId).filter((id) => !had.has(id)),
          },
        ];
      })
    : [];
  return { matchRun: { ...run }, previousRunId: prev?.id ?? null, changes };
}

function notFound(): never {
  throw new ApiRequestError("not_found", 404, "That record isn't available.");
}

export const fixtureApi: Api = {
  async listEvidence() {
    await wait(250);
    // Clones: records are mutated in place, React must see new objects.
    const evidence = store.evidence.map((e) => ({ ...e })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return { worker, evidence };
  },

  async getEvidence(id) {
    const evidence = store.evidence.find((e) => e.id === id) ?? notFound();
    return { evidence: { ...evidence }, documentUrl: null };
  },

  async extractFile(file) {
    await wait(1600);
    const draft: EvidenceDraft = {
      draftId: crypto.randomUUID(),
      sourceKind: "pdf_upload",
      fileName: file.name,
      extraction: {
        type: "checklist",
        title: "Heat-pump commissioning checklist — residential install",
        date: "2026-11-12",
        issuer: "Desert Air Mechanical (fictional employer)",
        structuredData: {
          skills: ["Heat-pump commissioning", "Refrigerant charge verification"],
          activities: ["Verified refrigerant charge by subcooling", "Confirmed airflow of 400 CFM per ton", "Tested defrost and auxiliary heat"],
          equipment: ["3-ton ducted air-source heat pump"],
          expirationDate: null,
          credentialNumber: null,
          summary: "Completed commissioning checklist for a residential heat-pump installation (fictional sample).",
        },
        uncertainFields: ["issuer"],
      },
      extractionError: null,
      duplicateOfEvidenceId: null,
      createdAt: now(),
    };
    store.drafts.set(draft.draftId, draft);
    return { draft };
  },

  async extractText(text) {
    await wait(1200);
    const draft: EvidenceDraft = {
      draftId: crypto.randomUUID(),
      sourceKind: "manual_text",
      fileName: null,
      extraction: {
        type: "experience_note",
        title: null,
        date: null,
        issuer: null,
        structuredData: { skills: [], activities: [], equipment: [], expirationDate: null, credentialNumber: null, summary: text.slice(0, 2000) },
        uncertainFields: ["title", "date"],
      },
      extractionError: null,
      duplicateOfEvidenceId: null,
      createdAt: now(),
    };
    store.drafts.set(draft.draftId, draft);
    return { draft };
  },

  async confirmEvidence({ draftId, fields }: ConfirmEvidenceRequest) {
    await wait(500);
    const draft = store.drafts.get(draftId) ?? notFound();
    store.drafts.delete(draftId);
    const evidence: Evidence = {
      ...fields,
      id: crypto.randomUUID(),
      workerId: worker.id,
      sourceKind: draft.sourceKind,
      sourceAvailable: false,
      verificationStatus: draft.sourceKind === "pdf_upload" ? "document_supplied" : "self_reported",
      indexStatus: "processing",
      indexError: null,
      isSynthetic: true,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    store.evidence.push(evidence);
    store.revision += 1;
    for (const run of store.runs) if (run.status === "completed") run.status = "stale";
    // Simulated indexing delay so the UI's polling states are exercised.
    setTimeout(() => {
      evidence.indexStatus = "indexed";
      evidence.updatedAt = now();
    }, 4000);
    return { evidence: { ...evidence } };
  },

  async reindex(id) {
    const evidence = store.evidence.find((e) => e.id === id) ?? notFound();
    evidence.indexStatus = "processing";
    setTimeout(() => (evidence.indexStatus = "indexed"), 3000);
    return { evidence: { ...evidence } };
  },

  async listOpportunities() {
    await wait(200);
    return { opportunities: [opportunity] };
  },

  async runMatch(opportunityId) {
    if (opportunityId !== opportunity.id) notFound();
    await wait(1800);
    const run: MatchRun = {
      id: crypto.randomUUID(),
      workerId: worker.id,
      opportunityId,
      status: "completed",
      evidenceRevision: store.revision,
      memoryWarning: null,
      results: buildResults(),
      createdAt: now(),
    };
    store.runs.push(run);
    return respond(run);
  },

  async getMatch(id) {
    return respond(store.runs.find((r) => r.id === id) ?? notFound());
  },

  async latestMatch(opportunityId) {
    await wait(200);
    const run = store.runs.filter((r) => r.opportunityId === opportunityId).at(-1);
    return run ? respond(run) : null;
  },
};
