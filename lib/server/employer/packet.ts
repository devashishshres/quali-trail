import type { Evidence, EvidenceAssessment, MatchRun, Opportunity, WorkerReview } from "@/lib/types";
import { EmployerPacket, PACKET_FORMAT, type PacketConfirmation, type PacketRecord, type ShareSelection } from "@/lib/types/employer";

export interface CustomerAck {
  evidenceId: string;
  evidenceVersion: number;
  status: string;
  deliveryMode: "resend" | "mock";
  decidedAt: string | null;
}

export interface PacketInputs {
  worker: { name: string; trade: string; isSynthetic: boolean };
  opportunity: Opportunity;
  run: MatchRun;
  evidence: Evidence[];
  customerAcks: CustomerAck[];
  reviews: WorkerReview[];
  /** Review request ids whose reviewer explicitly agreed to employer sharing at decision time. */
  consentedReviewIds: Set<string>;
  now: Date;
}

export class PacketSelectionError extends Error {
  constructor(public readonly reason: "no_report" | "no_records" | "not_in_report" | "no_original") {
    super(reason);
  }
}

/** Records the report links to any requirement, in first-appearance order. These are the only shareable ones. */
export function reportRecordIds(run: MatchRun): string[] {
  return [...new Set(run.results.flatMap((r) => r.connections.map((c) => c.evidenceId)))];
}

/**
 * The ONE function that decides what an employer sees. The technician's preview and the stored packet both come
 * from here, so the preview is exactly what is shared.
 *
 * Deliberately left out: free-text summaries, credential numbers, AI explanations and narrative text, customer
 * names/addresses/signatures/comments, supervisor comments and email addresses, and any record not selected.
 * A supervisor's self-entered name appears only with an explicit sharing consent recorded at decision time.
 */
export function buildPacket(input: PacketInputs, selection: Pick<ShareSelection, "recordIds" | "originalIds" | "includeConfirmations">): EmployerPacket {
  const { run, opportunity } = input;
  // Only a current report can be shared (printing has the same rule).
  if (run.status !== "completed") throw new PacketSelectionError("no_report");
  const linked = reportRecordIds(run);
  const chosen = new Set(selection.recordIds);
  if (!chosen.size) throw new PacketSelectionError("no_records");
  for (const id of chosen) if (!linked.includes(id)) throw new PacketSelectionError("not_in_report");
  const byId = new Map(input.evidence.map((e) => [e.id, e]));
  for (const id of chosen) if (!byId.has(id)) throw new PacketSelectionError("not_in_report");
  const originals = new Set(selection.originalIds ?? []);
  for (const id of originals) if (!chosen.has(id) || !byId.get(id)!.sourceAvailable) throw new PacketSelectionError("no_original");

  const order = linked.filter((id) => chosen.has(id));
  const ref = new Map(order.map((id, i) => [id, `R${i + 1}`]));

  const records: PacketRecord[] = order.map((id) => {
    const e = byId.get(id)!;
    return {
      id,
      ref: ref.get(id)!,
      version: e.version,
      type: e.type,
      title: e.title,
      date: e.date,
      issuer: e.issuer,
      expirationDate: e.structuredData.expirationDate ?? null,
      verificationStatus: e.verificationStatus,
      activities: [...e.structuredData.activities],
      equipment: [...e.structuredData.equipment],
      skills: [...e.structuredData.skills],
      originalShared: originals.has(id),
      confirmations: selection.includeConfirmations ? confirmationsFor(e, input) : [],
    };
  });

  const reqById = new Map(opportunity.requirements.map((q) => [q.id, q]));
  const counts = { evidence_found: 0, needs_review: 0, no_sufficient_evidence: 0, cannot_assess: 0 } as Record<EvidenceAssessment, number>;
  const requirements = run.results.map((r) => {
    counts[r.assessment] = (counts[r.assessment] ?? 0) + 1;
    const shared = r.connections.filter((c) => chosen.has(c.evidenceId));
    return {
      text: r.originalText,
      priority: reqById.get(r.requirementId)?.priority ?? null,
      mandatory: r.mandatory,
      assessment: r.assessment,
      records: shared.map((c) => ({ ref: ref.get(c.evidenceId)!, role: c.role })),
      notSharedCount: r.connections.length - shared.length,
    };
  });

  const info = opportunity.importInfo ?? null;
  return EmployerPacket.parse({
    format: PACKET_FORMAT,
    generatedAt: input.now.toISOString(),
    isSynthetic: input.worker.isSynthetic || opportunity.isSynthetic,
    technician: { name: input.worker.name, trade: input.worker.trade },
    opportunity: {
      title: opportunity.title,
      employer: opportunity.employer,
      location: info?.location ?? null,
      sourceUrl: opportunity.sourceUrl,
      sourceKind: info?.sourceKind ?? "other",
    },
    report: { reference: run.id.slice(0, 8), createdAt: run.createdAt, status: run.status },
    counts,
    requirements,
    records,
    includesConfirmations: selection.includeConfirmations,
  });
}

/** Completed confirmations given for the CURRENT version of the record only. */
function confirmationsFor(e: Evidence, input: PacketInputs): PacketConfirmation[] {
  const out: PacketConfirmation[] = [];
  for (const a of input.customerAcks) {
    if (a.evidenceId !== e.id || a.evidenceVersion !== e.version || a.status !== "acknowledged") continue;
    out.push({ kind: "customer", decidedAt: a.decidedAt, simulated: a.deliveryMode === "mock" });
  }
  for (const r of input.reviews) {
    if (r.evidenceId !== e.id || r.evidenceVersion !== e.version) continue;
    if (r.status !== "confirmed_observed" && r.status !== "confirmed_documents") continue;
    const named = input.consentedReviewIds.has(r.id) && r.reviewerName;
    out.push({
      kind: "supervisor",
      basis: r.status === "confirmed_observed" ? "observed" : "documents",
      observedTasks: r.status === "confirmed_observed" ? [...r.observedTasks] : [],
      decidedAt: r.decidedAt,
      reviewer: named ? { name: r.reviewerName!, organization: r.reviewerOrganization, title: r.reviewerTitle } : null,
    });
  }
  return out;
}
