"use client";
import { useEffect, useRef, useState } from "react";
import type { GateResponse, SnapshotResponse } from "@/lib/types";
import { customerApi } from "@/lib/client/signoff-api";
import { toApiError } from "@/lib/client/errors";

type View = "loading" | "invalid" | "gate" | "code" | "details" | "done" | "closed";
const TOKEN_KEY = "qt-signoff-token";

const CLOSED_TEXT: Record<string, string> = {
  expired: "This request has expired.",
  revoked: "The technician cancelled this request.",
  superseded: "The record changed after this request was sent, so this link no longer applies.",
  locked: "This request is locked after too many incorrect codes.",
  acknowledged: "A response was already recorded. Thank you.",
  correction_requested: "A response was already recorded. Thank you.",
  declined: "A response was already recorded. Thank you.",
};

function Simulated() {
  return (
    <p role="status" className="mb-4 rounded-md border-2 border-dashed border-orange bg-orange-wash px-3 py-2 text-sm font-semibold text-orange-ink">
      SIMULATED. This is a development test. No real email was sent, and entering a code here is not real email verification.
    </p>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <dt className="text-xs font-semibold text-slate">{label}</dt>
      <dd><ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{items.map((i) => <li key={i}>{i}</li>)}</ul></dd>
    </div>
  );
}

export default function SignoffPage() {
  const [view, setView] = useState<View>("loading");
  const [gate, setGate] = useState<GateResponse | null>(null);
  const [snap, setSnap] = useState<SnapshotResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"confirm" | "request_correction" | "decline" | null>(null);
  const token = useRef<string | null>(null);

  useEffect(() => {
    // The token lives in the URL fragment (never sent to a server). Read it once, then remove it from the address bar.
    let t: string | null = null;
    const m = /(?:^|&)t=([A-Za-z0-9_-]+)/.exec(window.location.hash.slice(1));
    if (m) {
      t = m[1];
      try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* storage unavailable: the page still works until reloaded */ }
      history.replaceState(null, "", window.location.pathname);
    } else {
      try { t = sessionStorage.getItem(TOKEN_KEY); } catch { t = null; }
    }
    token.current = t;
    (t ? customerApi.gate(t) : Promise.reject(new Error("no token")))
      .then((g) => {
        setGate(g);
        setView(g.status === "pending" ? "gate" : "closed");
      })
      .catch(() => setView("invalid"));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try { await fn(); } catch (e) { setMessage(toApiError(e).message); } finally { setBusy(false); }
  }
  const t = () => token.current!;

  const sendCode = () => run(async () => { await customerApi.sendCode(t()); setView("code"); });
  const verify = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    return run(async () => {
      await customerApi.verify(t(), code);
      setSnap(await customerApi.snapshot(t()));
      setView("details");
    });
  };
  const respond = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    return run(async () => {
      if (mode === "confirm") await customerApi.respond(t(), { decision: "confirm", typedName: String(f.get("name") ?? ""), agreed: true });
      else if (mode === "request_correction") await customerApi.respond(t(), { decision: "request_correction", comment: String(f.get("comment") ?? "") });
      else await customerApi.respond(t(), { decision: "decline" });
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      setView("done");
    });
  };
  const optOut = () => run(async () => { await customerApi.optOut(t()); try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setView("closed"); setGate((g) => g && { ...g, status: "revoked" }); setMessage("You will not receive further requests from QualiTrail at this address."); });

  const sim = gate?.deliveryMode === "mock" || snap?.deliveryMode === "mock";

  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
      <div className="mt-6 rounded-lg border border-line bg-white p-5 sm:p-7">
        {sim && <Simulated />}
        {view === "loading" && <p className="text-slate">Loading…</p>}
        {view === "invalid" && (
          <>
            <h1 className="font-display text-2xl font-semibold">This link isn&apos;t valid</h1>
            <p className="mt-2 text-slate">It may have expired, been replaced by a newer link, or been opened in a different browser. Ask the technician to send a new request.</p>
          </>
        )}
        {view === "closed" && (
          <>
            <h1 className="font-display text-2xl font-semibold">This request is closed</h1>
            <p className="mt-2 text-slate">{message ?? CLOSED_TEXT[gate?.status ?? ""] ?? "It can no longer be answered."}</p>
          </>
        )}
        {view === "gate" && gate && (
          <>
            <h1 className="font-display text-2xl font-semibold">{gate.workerName} asked you to acknowledge a description of work</h1>
            <p className="mt-3 text-slate">
              To see the details, first confirm this is your email address. We will send a one-time code to <strong>{gate.emailHint ?? "the address the technician provided"}</strong>.
              Nothing about the job is shown until you enter it.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button className="btn btn-primary" onClick={sendCode} disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
              <button className="btn btn-quiet" onClick={optOut} disabled={busy}>I don&apos;t want these requests</button>
            </div>
            <p className="mt-4 text-xs text-slate"><a className="underline" href="/signoff/privacy">How your information is used</a></p>
          </>
        )}
        {view === "code" && (
          <form onSubmit={verify} className="space-y-4">
            <h1 className="font-display text-2xl font-semibold">Enter your code</h1>
            <p className="text-slate">{sim ? "In this development test the code is in the developer outbox, not an inbox." : "We emailed a 6-digit code. It works once and expires in 10 minutes."}</p>
            <label className="block"><span className="mb-1 block text-sm font-semibold">6-digit code</span>
              <input name="code" className="field" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
            </label>
            <div className="flex flex-wrap gap-3">
              <button className="btn btn-primary" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
              <button type="button" className="btn btn-secondary" onClick={sendCode} disabled={busy}>Send a new code</button>
            </div>
          </form>
        )}
        {view === "details" && snap && (
          <div className="space-y-5">
            <h1 className="font-display text-2xl font-semibold">Work described by {snap.snapshot.workerName}</h1>
            <p className="text-sm text-slate">This is what the technician recorded. You are only being asked whether it fairly describes work you know about.</p>
            <dl className="space-y-3 rounded-md bg-paper p-4">
              <div><dt className="text-xs font-semibold text-slate">Title</dt><dd className="font-semibold">{snap.snapshot.title}</dd></div>
              {snap.snapshot.date && <div><dt className="text-xs font-semibold text-slate">Date</dt><dd>{snap.snapshot.date}</dd></div>}
              {snap.snapshot.issuer && <div><dt className="text-xs font-semibold text-slate">Issuer or employer (as recorded)</dt><dd>{snap.snapshot.issuer}</dd></div>}
              {snap.snapshot.summary && <div><dt className="text-xs font-semibold text-slate">Summary</dt><dd className="text-sm">{snap.snapshot.summary}</dd></div>}
              <List label="Work performed" items={snap.snapshot.activities} />
              <List label="Skills" items={snap.snapshot.skills} />
              <List label="Equipment" items={snap.snapshot.equipment} />
            </dl>
            {!mode ? (
              <div className="flex flex-wrap gap-3">
                <button className="btn btn-primary" onClick={() => setMode("confirm")}>Acknowledge</button>
                <button className="btn btn-secondary" onClick={() => setMode("request_correction")}>Something is wrong</button>
                <button className="btn btn-quiet" onClick={() => setMode("decline")}>I can&apos;t confirm this</button>
              </div>
            ) : (
              <form onSubmit={respond} className="space-y-4 border-t border-line pt-4">
                {mode === "confirm" && (
                  <>
                    <p className="text-sm">{snap.statement}</p>
                    <label className="block"><span className="mb-1 block text-sm font-semibold">Type your full name as your signature</span>
                      <input name="name" className="field" autoComplete="name" minLength={2} maxLength={200} required />
                    </label>
                    <label className="flex gap-2 text-sm"><input type="checkbox" required /> I agree with the statement above.</label>
                  </>
                )}
                {mode === "request_correction" && (
                  <label className="block"><span className="mb-1 block text-sm font-semibold">What should be corrected? (up to 1,000 characters)</span>
                    <textarea name="comment" className="field" rows={4} maxLength={1000} required />
                  </label>
                )}
                {mode === "decline" && <p className="text-sm">You are saying you can&apos;t confirm this description. The technician will see that you declined.</p>}
                <div className="flex gap-3">
                  <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Submit"}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setMode(null)} disabled={busy}>Back</button>
                </div>
              </form>
            )}
            <p className="text-xs text-slate">{sim ? "Simulated: no real email verification took place." : "Your answer is only an acknowledgment. Neither your identity nor the work is independently verified by QualiTrail."}</p>
          </div>
        )}
        {view === "done" && (
          <>
            <h1 className="font-display text-2xl font-semibold">Thank you</h1>
            <p className="mt-2 text-slate">Your response was recorded and the technician can see it. You can close this page.</p>
          </>
        )}
        {message && view !== "closed" && <p role="alert" className="mt-4 text-sm text-danger">{message}</p>}
      </div>
    </main>
  );
}
