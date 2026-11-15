"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { accountsApi } from "@/lib/client/accounts-api";
import { reviewerApi } from "@/lib/client/employer-api";
import { toApiError } from "@/lib/client/errors";
import { formatStamp } from "@/lib/client/labels";

const KEY = "qt-employer-share";
type Share = { status: string; workerName: string | null; emailHint: string | null; expiresAt: string | null; answered: boolean };
type View = "loading" | "invalid" | "closed" | "signed_out" | "ready";

/**
 * Employer share invitation. The token is in the URL fragment (never sent to a server), kept only in this tab while
 * the person signs in or creates an account, and sent in a header. Opening needs a signed-in account whose confirmed
 * email is the invited address; the page itself shows nothing from the packet.
 */
export default function EmployerInvitePage() {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const [view, setView] = useState<View>("loading");
  const [share, setShare] = useState<Share | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let t: string | null = null;
    const m = /(?:^|&)t=([A-Za-z0-9_-]+)/.exec(window.location.hash.slice(1));
    if (m) {
      t = m[1];
      try { sessionStorage.setItem(KEY, t); } catch { /* still works until reload */ }
      history.replaceState(null, "", window.location.pathname);
    } else {
      try { t = sessionStorage.getItem(KEY); } catch { t = null; }
    }
    token.current = t;
    (t ? reviewerApi.peek(t) : Promise.reject(new Error("no token")))
      .then(async (s) => {
        setShare(s);
        try {
          const who = await accountsApi.me();
          setMe(who.email);
          setView(s.status === "pending" || (s.answered && s.status === "active") ? "ready" : "closed");
        } catch {
          setView(s.status === "pending" ? "signed_out" : "closed");
        }
      })
      .catch(() => setView("invalid"));
  }, []);

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await reviewerApi.accept(token.current!);
      try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      router.replace(`/employer/${r.id}`);
    } catch (e) {
      setMessage(toApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  const here = "/invite/employer";
  return (
    <main className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
      <div className="sheet mt-6 space-y-4 p-5 sm:p-7">
        {view === "loading" && <p className="text-slate">Loading…</p>}
        {view === "invalid" && <><h1 className="font-display text-2xl font-semibold">This link isn&apos;t valid</h1><p className="text-slate">It may have expired or been withdrawn. Ask the technician to share it again.</p></>}
        {view === "closed" && <><h1 className="font-display text-2xl font-semibold">This share isn&apos;t open</h1><p className="text-slate">{share?.status === "revoked" ? "The technician withdrew it." : share?.status === "expired" ? "It has expired." : share?.answered ? "It was already opened. Sign in with the address it was sent to and find it under your shared packets." : `Status: ${share?.status}.`}</p><Link className="btn btn-secondary" href="/employer">Your shared packets</Link></>}
        {share && (view === "signed_out" || view === "ready") && (
          <>
            <h1 className="font-display text-2xl font-semibold">{share.workerName ? `${share.workerName} shared a qualification packet with you` : "A technician shared a qualification packet with you"}</h1>
            {share.emailHint && <p className="text-slate">It was shared with <strong>{share.emailHint}</strong>. Only an account with that confirmed email address can open it.</p>}
            <p className="text-sm text-slate">
              Opening it shows only that you control that email address. It does not verify your identity, your employer or anything in the
              packet. The packet is read-only, and access ends{share.expiresAt ? ` ${formatStamp(share.expiresAt)}` : " when it expires"} or sooner if the technician withdraws it. Each time you open it, the technician can see that it was viewed.
            </p>
          </>
        )}
        {view === "signed_out" && (
          <div className="flex flex-wrap gap-3">
            <Link className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(here)}`}>Sign in</Link>
            <Link className="btn btn-secondary" href={`/sign-up?next=${encodeURIComponent(here)}`}>Create an account</Link>
          </div>
        )}
        {view === "ready" && (
          <>
            <p className="text-sm">Signed in as <strong>{me}</strong>.</p>
            <button className="btn btn-primary" disabled={busy} onClick={open}>{busy ? "Opening…" : "Open the packet"}</button>
          </>
        )}
        {message && <p role="alert" className="text-sm text-danger">{message}</p>}
      </div>
    </main>
  );
}
