"use client";
import { useCallback, useEffect, useState } from "react";
import type { Evidence, SignoffConfig, WorkerSignoff } from "@/lib/types";
import { toApiError } from "@/lib/client/errors";
import { signoffApi } from "@/lib/client/signoff-api";
import { signoffLabel } from "@/lib/client/signoff-labels";
import { SignoffTag } from "../ui/status";

type Outbox = Awaited<ReturnType<typeof signoffApi.outbox>>["messages"];

/** Customer sign-off for one saved work record or checklist. Hidden entirely when the feature is off. */
export function SignoffPanel({ evidence: e }: { evidence: Evidence }) {
  const [config, setConfig] = useState<SignoffConfig | null>(null);
  const [requests, setRequests] = useState<WorkerSignoff[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(null);

  const refresh = useCallback(async () => {
    try { setRequests((await signoffApi.list(e.id)).requests); } catch { /* shown as empty */ }
  }, [e.id]);

  useEffect(() => {
    let live = true;
    signoffApi.config().then((c) => { if (live) setConfig(c); if (live && c.enabled) void refresh(); }).catch(() => undefined);
    return () => { live = false; };
  }, [refresh, e.version]);

  if (!config?.enabled) return null;

  const open = requests.find((r) => r.status === "pending");
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try { await fn(); await refresh(); } catch (x) { setMessage(toApiError(x).message); } finally { setBusy(false); }
  }
  const submit = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    return act(async () => {
      await signoffApi.create({ evidenceId: e.id, customerEmail: String(f.get("email")), customerName: String(f.get("name") ?? "").trim() || null, customerAgreedToContact: true });
      form.reset();
    });
  };

  return (
    <section aria-label="Customer sign-off" className="space-y-3 border-t border-line pt-4">
      <h4 className="font-display text-lg font-semibold">Customer sign-off</h4>
      {config.mode === "mock" && (
        <p role="status" className="rounded-md border-2 border-dashed border-orange bg-orange-wash px-3 py-2 text-sm font-semibold text-orange-ink">
          SIMULATED delivery: no real email is sent. Messages go to a local developer outbox. Results are not real email verification.
        </p>
      )}
      <p className="text-sm text-slate">
        Ask a customer to acknowledge this description. They get a code at the address you give; their answer is an acknowledgment only. It does not make this record independently confirmed.
      </p>

      {requests.map((r) => {
        const l = signoffLabel(r, e.version);
        return (
          <div key={r.id} className="space-y-1 rounded-md border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><SignoffTag short={l.short} tone={l.tone} />{r.emailHint && <span className="text-slate">to {r.emailHint}</span>}</div>
            <p>{l.long}</p>
            {r.typedName && <p>Signed as: <strong>{r.typedName}</strong></p>}
            {r.comment && <p>Customer note (untrusted text): <span className="whitespace-pre-wrap">{r.comment}</span></p>}
            {r.status === "pending" && (
              <div className="flex gap-2 pt-1">
                <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => signoffApi.resend(r.id))}>Resend invitation</button>
                <button className="btn btn-quiet" disabled={busy} onClick={() => act(() => signoffApi.revoke(r.id))}>Cancel request</button>
              </div>
            )}
          </div>
        );
      })}

      {!config.ready ? (
        <p className="text-sm text-slate">Sending isn&apos;t configured on this server yet.</p>
      ) : !open ? (
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-sm font-semibold">Customer email</span><input name="email" type="email" className="field" required maxLength={320} /></label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">Customer name (optional)</span><input name="name" className="field" maxLength={200} /></label>
          </div>
          <label className="flex gap-2 text-sm"><input name="agreed" type="checkbox" required /> This customer agreed to be contacted by QualiTrail about this record.</label>
          <button className="btn btn-secondary" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
        </form>
      ) : null}

      {config.mode === "mock" && (
        <div>
          <button className="btn btn-quiet" onClick={async () => setOutbox((await signoffApi.outbox().catch(() => ({ messages: [] }))).messages)}>Show simulated outbox</button>
          {outbox && (
            <ul className="mt-2 space-y-2">
              {outbox.length === 0 && <li className="text-sm text-slate">No simulated messages yet.</li>}
              {outbox.map((m) => (
                <li key={m.at + m.kind} className="rounded-md border border-dashed border-orange p-2 text-xs"><strong>SIMULATED: {m.subject}</strong><pre className="mt-1 whitespace-pre-wrap">{m.text}</pre></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {message && <p role="alert" className="text-sm text-danger">{message}</p>}
    </section>
  );
}
