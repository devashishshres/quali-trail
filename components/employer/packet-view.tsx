"use client";
import { REPORT_DISCLAIMER, type EvidenceAssessment } from "@/lib/types";
import type { EmployerPacket, PacketConfirmation, PacketRecord } from "@/lib/types/employer";
import { CANNOT_ASSESS_NOTE, NO_EVIDENCE_NOTE, PRIORITY_LABEL, TYPE_LABEL, formatDate, formatStamp } from "@/lib/client/labels";
import { AssessmentLabel, FictionalTag, SignoffTag, VerificationTag } from "@/components/ui/status";

/**
 * The read-only packet, exactly as stored. The technician's preview and the employer's view both render THIS
 * component from the same packet object, so what the technician previews is what the employer sees.
 */
export function PacketView({
  packet,
  changedRecordIds = [],
  onOpenOriginal,
}: {
  packet: EmployerPacket;
  changedRecordIds?: string[];
  /** Present only for the employer view while the share is active. */
  onOpenOriginal?: (recordId: string) => void;
}) {
  const changed = new Set(changedRecordIds);
  const byRef = new Map(packet.records.map((r) => [r.ref, r]));
  return (
    <article className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-navy pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">Qualification packet, shared read-only by the technician</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight">{packet.technician.name}</h2>
          <p>{packet.technician.trade}</p>
        </div>
        <dl className="text-right text-sm">
          <dt className="text-slate">For the job</dt>
          <dd className="font-semibold">{packet.opportunity.title}</dd>
          <dd>{packet.opportunity.employer}{packet.opportunity.location ? `, ${packet.opportunity.location}` : ""}</dd>
          <dt className="mt-1 text-slate">Report run</dt>
          <dd className="font-medium">{formatStamp(packet.report.createdAt)} (ref {packet.report.reference}){packet.report.status === "stale" ? ", out of date when shared" : ""}</dd>
        </dl>
      </header>

      {packet.isSynthetic && <p className="flex items-center gap-2 text-sm"><FictionalTag /> Some of this packet is fictional demonstration data.</p>}
      {changed.size > 0 && (
        <p role="status" className="rounded-md border border-orange/50 bg-orange-wash px-4 py-3 text-sm text-orange-ink">
          The technician has edited or removed {changed.size} of these records since sharing. This packet still shows them exactly as they were when shared.
        </p>
      )}

      <p className="flex flex-wrap gap-x-6 gap-y-2 rounded-md bg-paper px-4 py-3 text-sm">
        {(Object.keys(packet.counts) as EvidenceAssessment[]).map((a) => (
          <span key={a} className="flex items-center gap-2"><AssessmentLabel assessment={a} /><span className="font-semibold">{packet.counts[a]}</span></span>
        ))}
      </p>
      {packet.counts.cannot_assess > 0 && <p className="text-sm text-slate">&ldquo;Can&apos;t assess automatically&rdquo;: {CANNOT_ASSESS_NOTE}</p>}

      <section>
        <h3 className="font-display text-2xl font-semibold">Requirement by requirement</h3>
        <p className="text-sm text-slate">
          Assessment describes whether relevant documentation was found in the technician&apos;s records. It is not verification, and it
          was made from all of the technician&apos;s records, some of which they may not have shared here.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b-2 border-navy">
                <th className="py-2 pr-4 font-semibold">Requirement (as listed)</th>
                <th className="py-2 pr-4 font-semibold">Assessment</th>
                <th className="py-2 font-semibold">Shared records</th>
              </tr>
            </thead>
            <tbody>
              {packet.requirements.map((q, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="py-3 pr-4 font-medium">
                    {q.text}
                    <span className="block text-xs font-normal text-slate">{q.priority ? PRIORITY_LABEL[q.priority] : q.mandatory ? "" : "Optional"}</span>
                  </td>
                  <td className="py-3 pr-4"><AssessmentLabel assessment={q.assessment} /></td>
                  <td className="py-3">
                    {q.records.map((x) => (
                      <span key={x.ref} className="block">
                        <span className="font-medium">{x.ref}</span> {byRef.get(x.ref)?.title}
                        <span className="text-xs text-slate"> ({x.role === "direct" ? "could satisfy on its own" : "related, partial"})</span>
                      </span>
                    ))}
                    {q.records.length === 0 && q.notSharedCount === 0 && <span className="text-slate">No matching record</span>}
                    {q.notSharedCount > 0 && <span className="block text-xs text-slate">{q.notSharedCount} linked record{q.notSharedCount > 1 ? "s" : ""} not shared</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="font-display text-2xl font-semibold">Shared records</h3>
        <ul className="mt-2 space-y-4">
          {packet.records.map((r) => (
            <RecordItem key={r.id} r={r} changed={changed.has(r.id)} includesConfirmations={packet.includesConfirmations} onOpenOriginal={onOpenOriginal} />
          ))}
        </ul>
      </section>

      <footer className="border-t-2 border-navy pt-4 text-sm">
        <p className="font-semibold">{REPORT_DISCLAIMER}</p>
        <p className="mt-1 text-slate">{NO_EVIDENCE_NOTE}</p>
        <p className="mt-1 text-slate">
          Confirmations are statements by the people named or described, about the record version shown. They are not certification,
          licensing or credential verification. Reviewer details are self-entered and unverified, and appear only where the reviewer agreed.
        </p>
      </footer>
    </article>
  );
}

function RecordItem({ r, changed, includesConfirmations, onOpenOriginal }: { r: PacketRecord; changed: boolean; includesConfirmations: boolean; onOpenOriginal?: (id: string) => void }) {
  return (
    <li className="break-inside-avoid rounded-md border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p><span className="font-semibold">{r.ref}</span> <span className="font-medium">{r.title}</span></p>
        <VerificationTag status={r.verificationStatus} />
      </div>
      <p className="text-sm text-slate">
        {TYPE_LABEL[r.type]}, {formatDate(r.date)}{r.issuer ? `, ${r.issuer} (as recorded)` : ""}
        {r.expirationDate ? `. Expires ${formatDate(r.expirationDate)}` : ""}
        {changed ? ". Changed since sharing" : ""}
      </p>
      {([["Work performed", r.activities], ["Equipment", r.equipment], ["Skills", r.skills]] as const).map(([label, items]) =>
        items.length ? (
          <p key={label} className="mt-1 text-sm"><span className="font-semibold">{label}:</span> {items.join("; ")}</p>
        ) : null,
      )}
      {r.originalShared && (
        <p className="mt-2 text-sm">
          {onOpenOriginal ? (
            <button type="button" className="btn btn-secondary" onClick={() => onOpenOriginal(r.id)} disabled={changed}>
              {changed ? "Original no longer available (record changed)" : "Open original document"}
            </button>
          ) : (
            <span className="text-slate">Original document shared (opens for the recipient only).</span>
          )}
        </p>
      )}
      {includesConfirmations && r.confirmations.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {r.confirmations.map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <SignoffTag short={c.kind === "customer" ? (c.simulated ? "Customer acknowledgment (test mode)" : "Customer acknowledgment") : "Supervisor confirmation"} tone={c.kind === "customer" && c.simulated ? "simulated" : "neutral"} />
              <span className="text-slate">{describe(c)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function describe(c: PacketConfirmation): string {
  const when = c.decidedAt ? ` on ${formatDate(c.decidedAt.slice(0, 10))}` : "";
  if (c.kind === "customer") {
    return `A customer acknowledged that the description fairly describes work they received or witnessed${when}. Customer details are not shared.${c.simulated ? " Recorded in development test mode." : ""}`;
  }
  const who = c.reviewer ? `${c.reviewer.name}${c.reviewer.title ? `, ${c.reviewer.title}` : ""}${c.reviewer.organization ? `, ${c.reviewer.organization}` : ""} (self-entered, unverified)` : "A supervisor (details not shared)";
  return c.basis === "observed"
    ? `${who} confirmed personally observing: ${c.observedTasks.join("; ")}${when}.`
    : `${who} confirmed reviewing the supporting document, without stating they observed the work${when}.`;
}

