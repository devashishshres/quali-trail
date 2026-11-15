"use client";
import { useEffect, useState } from "react";
import type { AttestationsResponse } from "@/lib/types";
import { call } from "@/lib/client/signoff-api";
import { JobForm } from "@/components/evidence/job-form";
import { FIXTURE_MODE, api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { CapturePanel } from "@/components/evidence/capture-panel";
import { EvidenceList } from "@/components/evidence/evidence-list";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";

const loadAttestations = () => (FIXTURE_MODE ? Promise.resolve<AttestationsResponse>({ items: {} }) : call<AttestationsResponse>("/api/attestations"));

const POLL_MS = 3000;

export default function EvidencePage() {
  const list = useLoad(api.listEvidence);
  const att = useLoad(loadAttestations);
  const [savedJob, setSavedJob] = useState<string | null>(null);
  const evidence = list.data?.evidence ?? [];
  const indexing = evidence.some((e) => e.indexStatus === "pending" || e.indexStatus === "processing");

  // Poll while anything is still indexing; never show "indexed" before the API says so.
  useEffect(() => {
    if (!indexing) return;
    const t = setInterval(list.reload, POLL_MS);
    return () => clearInterval(t);
  }, [indexing, list.reload]);

  return (
    <>
      <PageHeader title="My Evidence" lede="Certificates, training and work records, each kept with its original source." />

      <section className="sheet p-5 sm:p-7">
        <CapturePanel onSaved={list.reload} />
      </section>

      {!FIXTURE_MODE && (
        <section className="sheet mt-6 p-5 sm:p-7">
          <JobForm
            onSaved={(e) => {
              setSavedJob(e.id);
              list.reload();
            }}
          />
          {savedJob && (
            <div className="mt-4">
              <Notice title="Job saved" action={<a className="btn btn-secondary" href={`#evidence-${savedJob}`}>Show it</a>}>
                Open it in your saved records to ask the customer to acknowledge it or a supervisor to review it.
              </Notice>
            </div>
          )}
        </section>
      )}

      <section className="mt-10" aria-labelledby="library">
        <div className="flex items-baseline justify-between gap-4 border-b-2 border-navy pb-2">
          <h2 id="library" className="font-display text-2xl font-semibold">
            Saved records
          </h2>
          {list.data && <span className="text-sm text-slate">{evidence.length} records</span>}
        </div>
        {list.status === "loading" && <Loading label="Loading your evidence…" />}
        {list.error && (
          <div className="mt-4">
            <ErrorNotice error={list.error} onRetry={list.reload} />
          </div>
        )}
        {list.data && (
          <EvidenceList
            evidence={evidence}
            attestations={att.data?.items ?? {}}
            onChanged={(e) =>
              list.data && list.setData({ ...list.data, evidence: evidence.map((x) => (x.id === e.id ? e : x)) })
            }
          />
        )}
      </section>
    </>
  );
}
