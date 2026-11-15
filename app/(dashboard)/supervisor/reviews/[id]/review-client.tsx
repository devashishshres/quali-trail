"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { ReviewDecision } from "@/lib/types";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { TYPE_LABEL, formatDate } from "@/lib/client/labels";
import { REVIEW_STATUS_LABEL } from "@/lib/client/review-labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";

const OPTIONS: { value: ReviewDecision; label: string; hint: string }[] = [
  { value: "confirm_observed", label: "I personally observed some or all of these tasks", hint: "You'll choose exactly which ones." },
  { value: "confirm_documents_reviewed", label: "I reviewed the supporting document", hint: "Only that you looked at the document. Not that you saw the work or that it is authentic." },
  { value: "request_correction", label: "Something needs correcting", hint: "Tell the technician what to fix." },
  { value: "decline", label: "I can't confirm this", hint: "For example, you weren't involved in this job." },
];

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return <div><dt className="text-xs font-semibold text-slate">{label}</dt><dd><ul className="mt-1 list-disc pl-5 text-sm">{items.map((i) => <li key={i}>{i}</li>)}</ul></dd></div>;
}

export function ReviewClient() {
  const { id } = useParams<{ id: string }>();
  const r = useLoad(() => accountsApi.review(id), id);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (r.status === "loading") return <Loading label="Loading the request…" />;
  if (r.error) return <ErrorNotice error={r.error} />;
  const { review, statements } = r.data!;
  const s = review.snapshot;
  const open = review.status === "pending" && !done;

  async function viewDocument() {
    try {
      const { url } = await accountsApi.reviewDocument(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setMessage(toApiError(e).message);
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const comment = String(f.get("comment") ?? "").trim() || null;
    setBusy(true);
    setMessage(null);
    try {
      if (decision === "confirm_observed") await accountsApi.respond(id, { decision, observedTasks: f.getAll("task").map(String), comment, agreed: true });
      else if (decision === "confirm_documents_reviewed") await accountsApi.respond(id, { decision, comment, agreed: true });
      else if (decision === "request_correction") await accountsApi.respond(id, { decision, comment: comment ?? "" });
      else if (decision === "decline") await accountsApi.respond(id, { decision, comment });
      setDone(true);
      r.reload();
    } catch (x) {
      setMessage(toApiError(x).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Review a job" lede={`Sent by ${s.workerName}. Your answer is recorded against exactly what you see here.`} />
      <div className="space-y-6">
        <dl className="sheet space-y-3 p-5 sm:p-7">
          <div><dt className="text-xs font-semibold text-slate">Job</dt><dd className="text-xl font-semibold">{s.title}</dd></div>
          <div className="flex flex-wrap gap-6 text-sm">
            <div><dt className="text-xs font-semibold text-slate">Date</dt><dd>{formatDate(s.date)}</dd></div>
            <div><dt className="text-xs font-semibold text-slate">Record type</dt><dd>{TYPE_LABEL[s.type as keyof typeof TYPE_LABEL] ?? s.type}</dd></div>
            {s.issuer && <div><dt className="text-xs font-semibold text-slate">Employer or issuer (as recorded)</dt><dd>{s.issuer}</dd></div>}
          </div>
          {s.summary && <div><dt className="text-xs font-semibold text-slate">Summary</dt><dd className="text-sm">{s.summary}</dd></div>}
          <List label="Work performed" items={s.activities} />
          <List label="Equipment" items={s.equipment} />
          <List label="Skills" items={s.skills} />
          {review.hasOriginal && open && <button type="button" className="btn btn-secondary" onClick={viewDocument}>View supporting document</button>}
          {!review.hasOriginal && <p className="text-sm text-slate">The technician didn&apos;t share a supporting document with this request.</p>}
        </dl>

        {!open && (
          <Notice title={REVIEW_STATUS_LABEL[review.status] ?? review.status}>
            {review.response
              ? `Recorded ${formatDate(review.response.createdAt.slice(0, 10))}.${review.response.observedTasks.length ? ` Tasks: ${review.response.observedTasks.join("; ")}.` : ""}${review.response.comment ? ` Comment: ${review.response.comment}` : ""}`
              : "This request is no longer open."}
          </Notice>
        )}

        {open && (
          <form onSubmit={submit} className="sheet space-y-4 p-5 sm:p-7">
            <h2 className="font-display text-2xl font-semibold">Your answer</h2>
            <fieldset className="space-y-2">
              {OPTIONS.filter((o) => o.value !== "confirm_documents_reviewed" || review.hasOriginal).map((o) => (
                <label key={o.value} className="flex gap-3 rounded-md border border-line p-3">
                  <input type="radio" name="decision" value={o.value} checked={decision === o.value} onChange={() => setDecision(o.value)} required />
                  <span><span className="block font-semibold">{o.label}</span><span className="block text-sm text-slate">{o.hint}</span></span>
                </label>
              ))}
            </fieldset>
            {decision === "confirm_observed" && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">Which tasks did you personally observe?</legend>
                {s.activities.length === 0 && <p className="text-sm text-danger">This record lists no tasks to confirm. Choose another answer.</p>}
                {s.activities.map((a) => <label key={a} className="flex gap-2 text-sm"><input type="checkbox" name="task" value={a} /> {a}</label>)}
                <label className="flex gap-2 rounded-md bg-paper p-3 text-sm"><input type="checkbox" required /> {statements.observed}</label>
              </fieldset>
            )}
            {decision === "confirm_documents_reviewed" && <label className="flex gap-2 rounded-md bg-paper p-3 text-sm"><input type="checkbox" required /> {statements.documents}</label>}
            {decision && (
              <label className="block"><span className="mb-1 block text-sm font-semibold">{decision === "request_correction" ? "What should be corrected?" : "Comment (optional)"}</span>
                <textarea name="comment" className="field" rows={3} maxLength={2000} required={decision === "request_correction"} />
              </label>
            )}
            {message && <p role="alert" className="text-sm text-danger">{message}</p>}
            <button className="btn btn-primary" disabled={busy || !decision}>{busy ? "Saving…" : "Submit answer"}</button>
            <p className="text-xs text-slate">This is not certification or credential verification, and it doesn&apos;t change how the record is labelled for authenticity.</p>
          </form>
        )}
        {!open && message && <p role="alert" className="text-sm text-danger">{message}</p>}
        <Link className="btn btn-quiet" href="/supervisor">Back to reviews</Link>
      </div>
    </>
  );
}
