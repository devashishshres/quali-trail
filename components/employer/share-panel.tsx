"use client";
import { useState } from "react";
import type { Evidence, MatchRun, Opportunity } from "@/lib/types";
import type { EmployerPacket, SharedPacket, WorkerShare } from "@/lib/types/employer";
import { shareApi } from "@/lib/client/employer-api";
import { toApiError } from "@/lib/client/errors";
import { formatStamp } from "@/lib/client/labels";
import { useLoad } from "@/lib/client/use-load";
import { Notice } from "@/components/ui/states";
import { PacketView } from "./packet-view";

const STATUS: Record<WorkerShare["status"], string> = { pending: "Sent, not opened yet", active: "Opened", revoked: "Withdrawn", expired: "Expired" };

/**
 * Share this job's report with ONE employer reviewer. The technician chooses the records, any originals and whether
 * to include completed confirmations, previews exactly what will be shared (the same view the reviewer gets), and
 * only then sends it. Shown only while the employer review feature is on.
 */
export function EmployerSharePanel({ opportunity, run, evidence }: { opportunity: Opportunity; run: MatchRun; evidence: Evidence[] }) {
  const shares = useLoad(shareApi.list);
  const linked = [...new Set(run.results.flatMap((r) => r.connections.map((c) => c.evidenceId)))];
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const records = linked.map((id) => byId.get(id)).filter((e): e is Evidence => Boolean(e));

  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(records.map((e) => e.id)));
  const [originals, setOriginals] = useState<Set<string>>(new Set());
  const [includeConfirmations, setIncludeConfirmations] = useState(true);
  const [email, setEmail] = useState("");
  const [validDays, setValidDays] = useState<3 | 7 | 14 | 30>(7);
  const [preview, setPreview] = useState<EmployerPacket | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SharedPacket | null>(null);

  const mine = (shares.data?.shares ?? []).filter((s) => s.opportunityId === opportunity.id);
  const selection = () => ({ opportunityId: opportunity.id, recordIds: [...chosen], originalIds: [...originals].filter((id) => chosen.has(id)), includeConfirmations });
  const invalidate = () => { setPreview(null); setReviewed(false); };
  const toggle = (set: Set<string>, id: string, on: boolean) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); return n; };

  async function doPreview() {
    setBusy(true); setMessage(null);
    try { setPreview((await shareApi.preview(selection())).packet); setReviewed(false); }
    catch (e) { setMessage(toApiError(e).message); }
    finally { setBusy(false); }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || !reviewed) return;
    setBusy(true); setMessage(null);
    try {
      await shareApi.create({ ...selection(), email, validDays, reviewed: true });
      setSentNotice(`Shared with ${email}. They'll need to sign in with that address to open it.`);
      setEmail(""); invalidate(); setOpen(false); shares.reload();
    } catch (x) { setMessage(toApiError(x).message); }
    finally { setBusy(false); }
  }
  async function withdraw(id: string) {
    setMessage(null);
    try { await shareApi.revoke(id); shares.reload(); if (viewing?.id === id) setViewing(null); }
    catch (x) { setMessage(toApiError(x).message); }
  }
  async function view(id: string) {
    setMessage(null);
    try { setViewing(viewing?.id === id ? null : await shareApi.get(id)); }
    catch (x) { setMessage(toApiError(x).message); }
  }

  if (!shares.data?.enabled) return null;
  const current = run.status === "completed";
  return (
    <section className="no-print sheet mb-4 space-y-4 p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold">Share with an employer</h2>
          <p className="text-sm text-slate">Send a read-only copy of this report to one person by email. You choose what&apos;s in it, see it first, and can withdraw it at any time.</p>
        </div>
        {!open && <button className="btn btn-secondary" disabled={!current || !shares.data.canSend} onClick={() => { setOpen(true); setSentNotice(null); }}>Share this report…</button>}
      </div>
      {!current && <p className="text-sm text-slate">Run matching again first: only a current report can be shared.</p>}
      {!shares.data.canSend && <p className="text-sm text-slate">Email isn&apos;t configured on this server, so reports can&apos;t be shared yet.</p>}
      {sentNotice && <Notice title="Shared">{sentNotice}</Notice>}

      {open && (
        <form onSubmit={send} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Records to include</legend>
            {records.map((e) => (
              <div key={e.id} className="rounded-md border border-line p-3 text-sm">
                <label className="flex gap-2"><input type="checkbox" checked={chosen.has(e.id)} onChange={(x) => { setChosen(toggle(chosen, e.id, x.target.checked)); invalidate(); }} /> <span className="font-medium">{e.title}</span></label>
                {e.sourceAvailable && chosen.has(e.id) && (
                  <label className="ml-6 mt-1 flex gap-2 text-slate"><input type="checkbox" checked={originals.has(e.id)} onChange={(x) => { setOriginals(toggle(originals, e.id, x.target.checked)); invalidate(); }} /> Also let them open the original document</label>
                )}
              </div>
            ))}
          </fieldset>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={includeConfirmations} onChange={(x) => { setIncludeConfirmations(x.target.checked); invalidate(); }} />
            <span>Include completed customer acknowledgments and supervisor confirmations for these records. Customers are never named. Supervisors are named only if they agreed when confirming.</span>
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="block min-w-64 flex-1"><span className="mb-1 block text-sm font-semibold">Their email address</span>
              <input className="field" type="email" required maxLength={320} value={email} onChange={(x) => setEmail(x.target.value)} autoComplete="off" />
            </label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">Access lasts</span>
              <select className="field w-auto" value={validDays} onChange={(x) => setValidDays(Number(x.target.value) as 3 | 7 | 14 | 30)}>
                {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-secondary" disabled={busy || chosen.size === 0} onClick={doPreview}>{busy && !preview ? "Building preview…" : "Preview exactly what they'll see"}</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setOpen(false); invalidate(); }}>Cancel</button>
          </div>
          {preview && (
            <>
              <div className="rounded-md border-2 border-dashed border-line p-4"><PacketView packet={preview} /></div>
              <label className="flex gap-2 text-sm font-medium"><input type="checkbox" checked={reviewed} onChange={(x) => setReviewed(x.target.checked)} /> I&apos;ve reviewed exactly what will be shared, and I want to send it to this address.</label>
              <button className="btn btn-primary" disabled={busy || !reviewed || !email}>{busy ? "Sharing…" : "Share"}</button>
            </>
          )}
        </form>
      )}
      {message && <p role="alert" className="text-sm text-danger">{message}</p>}

      {mine.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Shared from this report</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {mine.map((s) => (
              <li key={s.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{s.emailHint}</span> · {STATUS[s.status]} · {s.recordCount} record{s.recordCount === 1 ? "" : "s"} · shared {formatStamp(s.createdAt)}
                    <span className="block text-slate">
                      {s.views ? `Viewed ${s.views} time${s.views === 1 ? "" : "s"}, last ${formatStamp(s.lastViewedAt!)}` : "Not viewed yet"}
                      {s.originalsOpened ? `; originals opened ${s.originalsOpened}` : ""}
                      {s.status === "pending" || s.status === "active" ? `. Access ends ${formatStamp(s.expiresAt)}.` : "."}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <button className="btn btn-quiet" onClick={() => view(s.id)}>{viewing?.id === s.id ? "Hide" : "What was shared"}</button>
                    {(s.status === "pending" || s.status === "active") && <button className="btn btn-secondary" onClick={() => withdraw(s.id)}>Withdraw</button>}
                  </span>
                </div>
                {viewing?.id === s.id && <div className="mt-3 rounded-md border border-line p-4"><PacketView packet={viewing.packet} changedRecordIds={viewing.changedRecordIds} /></div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
