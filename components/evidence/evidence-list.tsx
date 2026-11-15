"use client";
import { useState } from "react";
import type { Evidence } from "@/lib/types";
import { api, openOriginal, toApiError } from "@/lib/client/api";
import { TYPE_LABEL, formatDate } from "@/lib/client/labels";
import { FictionalTag, IndexStatus, VerificationTag } from "../ui/status";
import { Icon } from "../ui/icons";

function Facts({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <dt className="text-xs font-semibold text-slate">{label}</dt>
      <dd>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

function EvidenceItem({ evidence: e, onChanged }: { evidence: Evidence; onChanged: (e: Evidence) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const sd = e.structuredData;

  async function retry() {
    setRetrying(true);
    setMessage(null);
    try {
      onChanged((await api.reindex(e.id)).evidence);
    } catch (err) {
      setMessage(toApiError(err).message);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <li id={`evidence-${e.id}`} className="scroll-mt-24 py-4 target:bg-orange-wash">
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] gap-x-4 gap-y-2 sm:grid-cols-[7.5rem_1fr_auto]">
          <span className="text-sm font-medium text-slate sm:pt-0.5">{formatDate(e.date)}</span>
          <span className="col-span-2 min-w-0 sm:col-span-1">
            <span className="block font-semibold group-open:text-navy">{e.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate">
              <span>{TYPE_LABEL[e.type]}</span>
              {e.issuer && <span className="truncate">{e.issuer}</span>}
            </span>
          </span>
          <span className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:flex-col sm:items-end">
            <VerificationTag status={e.verificationStatus} />
            <IndexStatus status={e.indexStatus} />
          </span>
        </summary>

        <div className="mt-4 space-y-4 border-l-2 border-line pl-4 sm:ml-[8.5rem]">
          {sd.summary && <p className="max-w-prose text-sm">{sd.summary}</p>}
          <dl className="grid gap-4 sm:grid-cols-3">
            <Facts label="Skills" items={sd.skills} />
            <Facts label="Work performed" items={sd.activities} />
            <Facts label="Equipment" items={sd.equipment} />
          </dl>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {sd.credentialNumber && (
              <div>
                <dt className="inline text-slate">Credential number </dt>
                <dd className="inline font-medium">{sd.credentialNumber}</dd>
              </div>
            )}
            <div>
              <dt className="inline text-slate">Expires </dt>
              <dd className="inline font-medium">{sd.expirationDate ? formatDate(sd.expirationDate) : "No expiry stated"}</dd>
            </div>
          </dl>
          {e.indexStatus === "failed" && (
            <p className="text-sm text-danger">{e.indexError ?? "Memory indexing failed."}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {e.isSynthetic && <FictionalTag />}
            {e.sourceAvailable ? (
              <button className="btn btn-secondary" onClick={async () => setMessage(await openOriginal(e.id))}>
                <Icon name="external" className="size-4" /> View original
              </button>
            ) : (
              <span className="text-sm text-slate">No original file stored</span>
            )}
            {e.indexStatus === "failed" && (
              <button className="btn btn-secondary" onClick={retry} disabled={retrying}>
                <Icon name="refresh" className="size-4" /> {retrying ? "Retrying…" : "Retry indexing"}
              </button>
            )}
          </div>
          {message && <p className="text-sm text-danger" role="alert">{message}</p>}
        </div>
      </details>
    </li>
  );
}

export function EvidenceList({ evidence, onChanged }: { evidence: Evidence[]; onChanged: (e: Evidence) => void }) {
  if (!evidence.length) {
    return <p className="py-8 text-slate">No evidence yet. Upload a certificate or describe a job above to start your record.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {evidence.map((e) => (
        <EvidenceItem key={e.id} evidence={e} onChanged={onChanged} />
      ))}
    </ul>
  );
}
