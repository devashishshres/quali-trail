"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Evidence, WorkerRelationship, WorkerReview } from "@/lib/types";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { reviewLabel } from "@/lib/client/review-labels";
import { SignoffTag } from "../ui/status";

/** Ask an accepted supervisor to review this saved work record or checklist. Hidden when the feature is off. */
export function ReviewPanel({ evidence: e }: { evidence: Evidence }) {
  const [enabled, setEnabled] = useState(false);
  const [supervisors, setSupervisors] = useState<WorkerRelationship[]>([]);
  const [reviews, setReviews] = useState<WorkerReview[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "info"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([accountsApi.supervisors(), accountsApi.reviews(e.id)]);
      setEnabled(s.enabled);
      setSupervisors(s.relationships.filter((x) => x.status === "accepted"));
      setReviews(r.reviews);
    } catch {
      setEnabled(false);
    }
  }, [e.id]);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh, e.version]);

  if (!enabled) return null;
  async function act(fn: () => Promise<{ notice?: string | null } | unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const out = (await fn()) as { notice?: string | null } | undefined;
      if (out && typeof out === "object" && "notice" in out && out.notice) setMessage({ tone: "danger", text: out.notice });
      else if (done) setMessage({ tone: "info", text: done });
      await refresh();
    } catch (x) {
      setMessage({ tone: "danger", text: toApiError(x).message });
    } finally {
      setBusy(false);
    }
  }
  const openFor = new Set(reviews.filter((r) => r.status === "pending").map((r) => r.relationshipId));
  const available = supervisors.filter((s) => !openFor.has(s.id));

  return (
    <section aria-label="Supervisor review" className="space-y-3 border-t border-line pt-4">
      <h4 className="font-display text-lg font-semibold">Supervisor review</h4>
      <p className="text-sm text-slate">A supervisor you&apos;ve connected with can say which tasks they personally observed, or that they reviewed your supporting document. It isn&apos;t certification and doesn&apos;t change this record&apos;s verification label.</p>
      {reviews.map((r) => {
        const l = reviewLabel(r, e.version);
        return (
          <div key={r.id} className="space-y-1 rounded-md border border-line p-3 text-sm">
            <SignoffTag short={l.short} tone={l.tone} />
            <p>{l.long}</p>
            {r.comment && <p>Supervisor comment: <span className="whitespace-pre-wrap">{r.comment}</span></p>}
            {r.status === "pending" && (
              <div className="flex gap-2 pt-1">
                <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => accountsApi.remindReview(r.id), "Reminder sent.")}>Send reminder</button>
                <button className="btn btn-quiet" disabled={busy} onClick={() => act(() => accountsApi.revokeReview(r.id), "Request withdrawn.")}>Withdraw</button>
              </div>
            )}
          </div>
        );
      })}
      {supervisors.length === 0 ? (
        <p className="text-sm text-slate"><Link className="underline" href="/supervisors">Invite a supervisor</Link> first; they need to accept before you can send jobs.</p>
      ) : available.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            const rel = String(new FormData(ev.currentTarget).get("relationship"));
            void act(() => accountsApi.requestReview(e.id, rel), "Sent. It's waiting in their QualiTrail reviews.");
          }}
        >
          <label className="block"><span className="mb-1 block text-sm font-semibold">Supervisor</span>
            <select name="relationship" className="field" required>
              {available.map((s) => <option key={s.id} value={s.id}>{s.supervisorName ?? s.emailHint}</option>)}
            </select>
          </label>
          <button className="btn btn-secondary" disabled={busy}>{busy ? "Sending…" : "Ask for review"}</button>
        </form>
      ) : null}
      {message && <p role={message.tone === "danger" ? "alert" : "status"} className={`text-sm ${message.tone === "danger" ? "text-danger" : "text-teal-ink"}`}>{message.text}</p>}
    </section>
  );
}
