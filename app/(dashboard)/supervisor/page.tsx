"use client";
import Link from "next/link";
import { useState } from "react";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { formatDate } from "@/lib/client/labels";
import { REVIEW_STATUS_LABEL } from "@/lib/client/review-labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";
import type { ReviewStatus } from "@/lib/types";

export default function SupervisorDashboard() {
  const d = useLoad(accountsApi.dashboard);
  const [message, setMessage] = useState<string | null>(null);
  const data = d.data;
  const pending = data?.reviews.filter((r) => r.status === "pending") ?? [];
  const done = data?.reviews.filter((r) => r.status !== "pending") ?? [];

  async function end(id: string) {
    if (!confirm("End this connection? You'll no longer see this technician's requests. Reviews you already gave are kept.")) return;
    try {
      await accountsApi.revokeRelationship(id);
      d.reload();
    } catch (e) {
      setMessage(toApiError(e).message);
    }
  }

  return (
    <>
      <PageHeader title="Reviews" lede="Jobs technicians have asked you to review. You only see what they send you." />
      {d.status === "loading" && <Loading label="Loading your reviews…" />}
      {d.error && <ErrorNotice error={d.error} onRetry={d.reload} />}
      {data && (
        <div className="space-y-10">
          {!data.enabled && <Notice title="Reviews are switched off">New review requests can&apos;t be answered while supervisor review is off on this server.</Notice>}
          <p className="text-sm text-slate">Signed in as {data.profile.name}{data.profile.title ? `, ${data.profile.title}` : ""}{data.profile.organization ? `, ${data.profile.organization}` : ""} (as you entered it; not verified).</p>
          <section>
            <h2 className="border-b-2 border-navy pb-2 font-display text-2xl font-semibold">Waiting for you</h2>
            {pending.length === 0 && <p className="py-6 text-slate">Nothing waiting.</p>}
            <ul className="divide-y divide-line">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div><p className="font-semibold">{r.title}</p><p className="text-sm text-slate">{r.workerName} · {formatDate(r.date)} · sent {formatDate(r.createdAt.slice(0, 10))}</p></div>
                  <Link className="btn btn-primary" href={`/supervisor/reviews/${r.id}`}>Review</Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="border-b-2 border-navy pb-2 font-display text-2xl font-semibold">Technicians you review</h2>
            {data.connections.length === 0 && <p className="py-6 text-slate">No connections yet. A technician has to invite you by email.</p>}
            <ul className="divide-y divide-line">
              {data.connections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span><strong>{c.workerName}</strong> <span className="text-sm text-slate">{c.trade} · since {formatDate(c.acceptedAt.slice(0, 10))}</span></span>
                  <button className="btn btn-quiet" onClick={() => end(c.id)}>End connection</button>
                </li>
              ))}
            </ul>
          </section>
          {done.length > 0 && (
            <section>
              <h2 className="border-b-2 border-navy pb-2 font-display text-2xl font-semibold">History</h2>
              <ul className="divide-y divide-line">
                {done.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span><strong>{r.title}</strong> <span className="text-sm text-slate">{r.workerName} · {REVIEW_STATUS_LABEL[r.status as ReviewStatus] ?? r.status}</span></span>
                    <Link className="btn btn-quiet" href={`/supervisor/reviews/${r.id}`}>View</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {message && <p role="alert" className="text-sm text-danger">{message}</p>}
        </div>
      )}
    </>
  );
}
