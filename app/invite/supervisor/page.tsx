"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { Notice } from "@/components/ui/states";

const KEY = "qt-supervisor-invite";
type Invite = { status: string; workerName: string | null; emailHint: string | null; answered?: boolean };
type View = "loading" | "invalid" | "closed" | "signed_out" | "ready" | "done";

/**
 * Supervisor invitation. The token is in the URL fragment (never sent to a server), kept only in this tab
 * while the person signs in or creates an account, and sent in a header. Accepting needs a signed-in account
 * whose confirmed email is the invited address; the page itself grants nothing.
 */
export default function SupervisorInvitePage() {
  const token = useRef<string | null>(null);
  const [view, setView] = useState<View>("loading");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [me, setMe] = useState<{ email: string | null; supervisor: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
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
    (t ? accountsApi.peekInvite(t) : Promise.reject(new Error("no token")))
      .then(async (inv) => {
        setInvite(inv);
        if (inv.status !== "pending") return setView("closed");
        try {
          const who = await accountsApi.me();
          setMe({ email: who.email, supervisor: Boolean(who.supervisor) });
          setView("ready");
        } catch {
          setView("signed_out");
        }
      })
      .catch(() => setView("invalid"));
  }, []);

  async function answer(accept: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await accountsApi.answerInvite(token.current!, accept);
      try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      setMessage(
        r.repeated
          ? accept ? "You'd already accepted this invitation. Requests from this technician appear in your reviews." : "You'd already declined this invitation."
          : accept ? "You're connected. Requests from this technician will appear in your reviews." : "Invitation declined.",
      );
      setView("done");
    } catch (e) {
      const err = toApiError(e) as { message: string } & { reason?: string };
      setMessage(err.message);
      setReason(/reviewer profile/.test(err.message) ? "needs_profile" : null);
    } finally {
      setBusy(false);
    }
  }

  const here = "/invite/supervisor";
  return (
    <main className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
      <div className="sheet mt-6 space-y-4 p-5 sm:p-7">
        {view === "loading" && <p className="text-slate">Loading…</p>}
        {view === "invalid" && <><h1 className="font-display text-2xl font-semibold">This invitation link isn&apos;t valid</h1><p className="text-slate">It may have expired or been replaced by a newer email. Ask the technician to send it again.</p></>}
        {view === "closed" && invite?.answered && invite.status === "accepted" && <><h1 className="font-display text-2xl font-semibold">This invitation was already accepted</h1><p className="text-slate">If you accepted it, sign in with the invited address to see the technician&apos;s requests. The link can&apos;t be used by anyone else.</p><Link className="btn btn-primary" href="/supervisor">Go to your reviews</Link></>}
        {view === "closed" && !(invite?.answered && invite.status === "accepted") && <><h1 className="font-display text-2xl font-semibold">This invitation is closed</h1><p className="text-slate">Status: {invite?.status}. Ask the technician for a new invitation if you need one.</p></>}
        {invite && (view === "signed_out" || view === "ready") && (
          <>
            <h1 className="font-display text-2xl font-semibold">{invite.workerName} invited you to review their completed jobs</h1>
            <p className="text-slate">The invitation was sent to <strong>{invite.emailHint}</strong>. Only an account with that confirmed email address can accept it.</p>
            <p className="text-sm text-slate">Accepting confirms that you control that address and agree to receive review requests. It does not verify your employment, your role or anyone&apos;s credentials. You only ever see jobs the technician sends you, and either of you can end the connection at any time.</p>
          </>
        )}
        {view === "signed_out" && (
          <div className="flex flex-wrap gap-3">
            <Link className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(here)}`}>Sign in</Link>
            <Link className="btn btn-secondary" href={`/sign-up?next=${encodeURIComponent(here)}`}>Create an account</Link>
          </div>
        )}
        {view === "ready" && me && (
          <>
            <p className="text-sm">Signed in as <strong>{me.email}</strong>.</p>
            {!me.supervisor || reason === "needs_profile" ? (
              <Notice title="Set up your reviewer profile first" action={<Link className="btn btn-primary" href={`/onboarding?role=supervisor&next=${encodeURIComponent(here)}`}>Set up profile</Link>}>
                Add your name (and optionally organization and title). They are shown with your reviews and are not verified.
              </Notice>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button className="btn btn-primary" disabled={busy} onClick={() => answer(true)}>{busy ? "Saving…" : "Accept"}</button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => answer(false)}>Decline</button>
              </div>
            )}
          </>
        )}
        {view === "done" && <><h1 className="font-display text-2xl font-semibold">Done</h1><p>{message}</p><Link className="btn btn-primary" href="/supervisor">Go to your reviews</Link></>}
        {message && view !== "done" && <p role="alert" className="text-sm text-danger">{message}</p>}
      </div>
    </main>
  );
}
