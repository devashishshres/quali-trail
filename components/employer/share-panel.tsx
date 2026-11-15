"use client";
import { useState } from "react";
import type { EmployerPacket, SharedPacket, WorkerShare } from "@/lib/types/employer";
import { shareApi } from "@/lib/client/employer-api";
import { toApiError } from "@/lib/client/errors";
import { VERIFICATION_LABEL, formatDate, formatStamp } from "@/lib/client/labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading, Notice } from "@/components/ui/states";
import { PacketView } from "./packet-view";

const STATUS: Record<WorkerShare["status"], string> = { pending: "Sent, not opened yet", active: "Opened", revoked: "Withdrawn", expired: "Expired" };

/**
 * Share confirmed work and uploaded certifications with ONE employer reviewer. Nothing is selected by default,
 * certificate originals need a separate tick each, and the technician must preview exactly what will be shared
 * (the same view the reviewer gets) before sending.
 */
export function EmployerSharePanel() {
  const shares = useLoad(shareApi.list);
  const cands = useLoad(shareApi.candidates);
  const [work, setWork] = useState<Set<string>>(new Set());
  const [certs, setCerts] = useState<Set<string>>(new Set());
  const [originals, setOriginals] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [validDays, setValidDays] = useState<3 | 7 | 14 | 30>(7);
  const [preview, setPreview] = useState<EmployerPacket | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SharedPacket | null>(null);

  const selection = () => ({ workIds: [...work], certificationIds: [...certs], originalIds: [...originals].filter((id) => certs.has(id)) });
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
      setEmail(""); setWork(new Set()); setCerts(new Set()); setOriginals(new Set()); invalidate(); shares.reload();
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

  if (shares.status === "loading" || cands.status === "loading") return <Loading label="Loading your records…" />;
  if (shares.error) return <ErrorNotice error={shares.error} onRetry={shares.reload} />;
  if (cands.error) return <ErrorNotice error={cands.error} onRetry={cands.reload} />;
  if (!shares.data!.enabled) return <p className="text-slate">Sharing with employers isn&apos;t available.</p>;
  const c = cands.data!;
  const eligibleWork = c.work.filter((w) => w.eligible);
  const ineligible = c.work.filter((w) => !w.eligible);
  const withheld = c.work.reduce((n, w) => n + w.withheldCount, 0);
  const anyOriginal = [...originals].some((id) => certs.has(id));
  const list = shares.data!.shares;

  return (
    <div className="space-y-6">
      {sentNotice && <Notice title="Shared">{sentNotice}</Notice>}
      {!shares.data!.canSend && <Notice tone="warning" title="Email isn't set up">Email isn&apos;t configured on this server, so nothing can be shared yet.</Notice>}

      <form onSubmit={send} className="sheet space-y-5 p-5 sm:p-7">
        <fieldset className="space-y-2">
          <legend className="font-display text-xl font-semibold">Confirmed work</legend>
          <p className="text-sm text-slate">Only jobs with a confirmation the confirmer allowed to be shared outside QualiTrail. Shows the job title, date and what was confirmed.</p>
          {eligibleWork.length === 0 && <p className="text-sm text-slate">None yet.</p>}
          {eligibleWork.map((w) => (
            <label key={w.id} className="flex gap-2 rounded-md border border-line p-3 text-sm">
              <input type="checkbox" checked={work.has(w.id)} onChange={(x) => { setWork(toggle(work, w.id, x.target.checked)); invalidate(); }} />
              <span><span className="font-medium">{w.title}</span> <span className="text-slate">({formatDate(w.date)}; {w.shareableCount} shareable confirmation{w.shareableCount === 1 ? "" : "s"})</span></span>
            </label>
          ))}
          {(ineligible.length > 0 || withheld > 0) && (
            <p className="text-xs text-slate">
              {ineligible.length > 0 && `${ineligible.length === 1 ? "1 job isn't listed because it has" : `${ineligible.length} jobs aren't listed because they have`} no confirmation that may be shared. `}
              {withheld > 0 && `${withheld} confirmation${withheld === 1 ? " was" : "s were"} given without permission to share outside QualiTrail (for example, before this option existed), so ${withheld === 1 ? "it stays" : "they stay"} private.`}
            </p>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-display text-xl font-semibold">Uploaded certifications</legend>
          {c.certifications.length === 0 && <p className="text-sm text-slate">No uploaded certificates.</p>}
          {c.certifications.map((x) => (
            <div key={x.id} className="rounded-md border border-line p-3 text-sm">
              <label className="flex gap-2">
                <input type="checkbox" checked={certs.has(x.id)} onChange={(e) => { setCerts(toggle(certs, x.id, e.target.checked)); if (!e.target.checked) setOriginals(toggle(originals, x.id, false)); invalidate(); }} />
                <span><span className="font-medium">{x.title}</span> <span className="text-slate">({VERIFICATION_LABEL[x.verificationStatus]}{x.issuer ? `, ${x.issuer}` : ""})</span></span>
              </label>
              {certs.has(x.id) && (
                <label className="ml-6 mt-1 flex gap-2 text-slate">
                  <input type="checkbox" checked={originals.has(x.id)} onChange={(e) => { setOriginals(toggle(originals, x.id, e.target.checked)); invalidate(); }} />
                  Also allow them to open the original certificate file
                </label>
              )}
            </div>
          ))}
        </fieldset>

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
        <button type="button" className="btn btn-secondary" disabled={busy || (work.size === 0 && certs.size === 0)} onClick={doPreview}>{busy && !preview ? "Building preview…" : "Preview exactly what they'll see"}</button>

        {preview && (
          <>
            {anyOriginal && (
              <p role="alert" className="rounded-md border border-orange/50 bg-orange-wash px-4 py-3 text-sm text-orange-ink">
                Original certificates may contain personal information, such as your date of birth, home address, licence or ID numbers, or a photo.
                Check each file before sharing it. The recipient can download any original you allow.
              </p>
            )}
            <div data-preview className="rounded-md border-2 border-dashed border-line p-4"><PacketView packet={preview} /></div>
            <label className="flex gap-2 text-sm font-medium"><input type="checkbox" checked={reviewed} onChange={(x) => setReviewed(x.target.checked)} /> I&apos;ve reviewed exactly what will be shared, and I want to send it to this address.</label>
            <button className="btn btn-primary" disabled={busy || !reviewed || !email || !shares.data!.canSend}>{busy ? "Sharing…" : "Share"}</button>
          </>
        )}
        {message && <p role="alert" className="text-sm text-danger">{message}</p>}
      </form>

      {list.length > 0 && (
        <section className="sheet p-5 sm:p-7">
          <h2 className="font-display text-xl font-semibold">What you&apos;ve shared</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {list.map((s) => (
              <li key={s.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{s.emailHint}</span> · {STATUS[s.status]} · {s.workCount} job{s.workCount === 1 ? "" : "s"}, {s.certificationCount} certification{s.certificationCount === 1 ? "" : "s"} · shared {formatStamp(s.createdAt)}
                    <span className="block text-slate">
                      {s.views ? `Viewed ${s.views} time${s.views === 1 ? "" : "s"}, last ${formatStamp(s.lastViewedAt!)}` : "Not viewed yet"}
                      {s.originalsOpened ? `; originals opened ${s.originalsOpened}` : ""}
                      {s.status === "pending" || s.status === "active" ? `. Access ends ${formatStamp(s.expiresAt)}.` : "."}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className="btn btn-quiet" onClick={() => view(s.id)}>{viewing?.id === s.id ? "Hide" : "What was shared"}</button>
                    {(s.status === "pending" || s.status === "active") && <button type="button" className="btn btn-secondary" onClick={() => withdraw(s.id)}>Withdraw</button>}
                  </span>
                </div>
                {viewing?.id === s.id && <div className="mt-3 rounded-md border border-line p-4"><PacketView packet={viewing.packet} changedRecordIds={viewing.changedRecordIds} /></div>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
