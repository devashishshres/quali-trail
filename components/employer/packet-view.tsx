"use client";
import type { EmployerPacket, PacketCertification, PacketConfirmation, PacketWork } from "@/lib/types/employer";
import { TYPE_LABEL, formatDate } from "@/lib/client/labels";
import { FictionalTag, SignoffTag, VerificationTag } from "@/components/ui/status";

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
  return (
    <article className="space-y-6">
      <header className="border-b-2 border-navy pb-4">
        <p className="text-xs font-semibold tracking-wide text-slate">Shared read-only by the technician</p>
        <h2 className="font-display text-3xl font-semibold tracking-tight">{packet.technician.name}</h2>
        <p>{packet.technician.trade}</p>
      </header>

      {packet.isSynthetic && <p className="flex items-center gap-2 text-sm"><FictionalTag /> This technician and their records are fictional demonstration data.</p>}
      {changed.size > 0 && (
        <p role="status" className="rounded-md border border-orange/50 bg-orange-wash px-4 py-3 text-sm text-orange-ink">
          The technician has edited or removed {changed.size} of these items since sharing. This packet still shows them exactly as they were when shared.
        </p>
      )}

      {packet.work.length > 0 && (
        <section>
          <h3 className="font-display text-2xl font-semibold">Confirmed work</h3>
          <p className="text-sm text-slate">Jobs the technician recorded that someone else confirmed. Only confirmations the confirmer allowed to be shared are shown.</p>
          <ul className="mt-3 space-y-4">
            {packet.work.map((w) => <WorkItem key={w.id} w={w} changed={changed.has(w.id)} />)}
          </ul>
        </section>
      )}

      {packet.certifications.length > 0 && (
        <section>
          <h3 className="font-display text-2xl font-semibold">Certifications</h3>
          <p className="text-sm text-slate">
            &ldquo;Document supplied&rdquo; means the technician uploaded the certificate and nobody has checked it with the issuer. Only
            &ldquo;Independently confirmed&rdquo; means a person confirmed it.
          </p>
          <ul className="mt-3 space-y-4">
            {packet.certifications.map((c) => <CertItem key={c.id} c={c} changed={changed.has(c.id)} onOpenOriginal={onOpenOriginal} />)}
          </ul>
        </section>
      )}

      <footer className="border-t-2 border-navy pt-4 text-sm text-slate">
        <p className="font-semibold text-navy">This packet is not a credential check, licence verification or job-fit assessment.</p>
        <p className="mt-1">
          Confirmations are statements by the people described, about the record version shown. Reviewer details are self-entered and
          unverified, and appear only where the reviewer allowed it.
        </p>
      </footer>
    </article>
  );
}

function WorkItem({ w, changed }: { w: PacketWork; changed: boolean }) {
  return (
    <li className="break-inside-avoid rounded-md border border-line p-4">
      <p className="font-medium">{w.title}</p>
      <p className="text-sm text-slate">{TYPE_LABEL[w.type]}, {formatDate(w.date)}{changed ? ". Changed since sharing" : ""}</p>
      <ul className="mt-2 space-y-2 text-sm">
        {w.confirmations.map((c, i) => (
          <li key={i}>
            <SignoffTag short={c.kind === "customer" ? (c.simulated ? "Customer acknowledgment (test mode)" : "Customer acknowledgment") : "Supervisor confirmation"} tone={c.kind === "customer" && c.simulated ? "simulated" : "neutral"} />
            <span className="mt-1 block text-slate">{describe(c)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function CertItem({ c, changed, onOpenOriginal }: { c: PacketCertification; changed: boolean; onOpenOriginal?: (id: string) => void }) {
  return (
    <li className="break-inside-avoid rounded-md border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{c.title}</p>
        <VerificationTag status={c.verificationStatus} />
      </div>
      <p className="text-sm text-slate">
        {c.issuer ? `Issuer as recorded: ${c.issuer}. ` : "Issuer not stated. "}
        {c.date ? `Issued ${formatDate(c.date)}. ` : ""}
        {c.expirationDate ? `Expires ${formatDate(c.expirationDate)}. ` : ""}
        {changed ? "Changed since sharing." : ""}
      </p>
      {c.verificationStatus === "document_supplied" && <p className="mt-1 text-xs text-slate">Uploaded by the technician. Not verified with the issuer.</p>}
      <p className="mt-2 text-sm">
        {!c.originalShared ? (
          <span className="text-slate">The original certificate was not shared.</span>
        ) : onOpenOriginal ? (
          <button type="button" className="btn btn-secondary" onClick={() => onOpenOriginal(c.id)} disabled={changed}>
            {changed ? "Original no longer available (changed since sharing)" : "Open original certificate"}
          </button>
        ) : (
          <span className="text-slate">Original certificate shared (opens for the recipient only).</span>
        )}
      </p>
    </li>
  );
}

function describe(c: PacketConfirmation): string {
  const when = c.decidedAt ? ` on ${formatDate(c.decidedAt.slice(0, 10))}` : "";
  if (c.kind === "customer") {
    const tasks = c.acknowledgedActivities.length ? ` The description listed: ${c.acknowledgedActivities.join("; ")}.` : "";
    return `A customer acknowledged${when} that the job description fairly describes work they received or witnessed.${tasks} Customers' names and contact details are never shared.${c.simulated ? " Recorded in development test mode." : ""}`;
  }
  const who = c.reviewer
    ? `${c.reviewer.name}${c.reviewer.title ? `, ${c.reviewer.title}` : ""}${c.reviewer.organization ? `, ${c.reviewer.organization}` : ""} (self-entered, unverified)`
    : "A supervisor";
  const what = c.basis === "observed"
    ? `${who} confirmed${when} personally observing: ${c.observedTasks.join("; ")}.`
    : `${who} confirmed${when} reviewing the supporting document, without stating they observed the work. (The document itself is not shared.)`;
  return c.reviewer ? what : `${what} The supervisor allowed this confirmation to be shared but did not permit their name to be shown.`;
}
