"use client";
import Link from "next/link";
import { useState } from "react";
import { Loading, Notice } from "@/components/ui/states";
import { authRequest } from "@/lib/client/auth-api";
import { toApiError } from "@/lib/client/errors";
import { useLoad } from "@/lib/client/use-load";

const readiness = () => authRequest<{ ready: boolean }>("/api/auth/reset-password");

/** Choose a new password. Works only within 15 minutes of opening a reset link, in the same browser. */
export default function ResetPasswordPage() {
  const state = useLoad(readiness);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setFieldError(null);
    if (f.get("password") !== f.get("confirm")) return setFieldError("The passwords don't match.");
    setBusy(true);
    try {
      await authRequest("/api/auth/reset-password", { password: f.get("password") });
      setDone(true);
    } catch (x) {
      const a = toApiError(x);
      if (a.fieldErrors?.password) setFieldError(a.fieldErrors.password.join(" "));
      else setError(a.message);
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (done) {
    body = (
      <Notice title="Password changed" action={<a className="btn btn-primary" href="/">Continue</a>}>
        Your new password is set. Other devices signed in to this account have been signed out.
      </Notice>
    );
  } else if (state.status === "loading") {
    body = <Loading label="Checking your reset link…" />;
  } else if (!state.data?.ready) {
    body = (
      <Notice tone="danger" title="This reset link has expired" action={<Link className="btn btn-primary" href="/forgot-password">Request a new link</Link>}>
        Reset links work once, in the browser that requested them, and you then have 15 minutes to choose a new password.
      </Notice>
    );
  } else {
    body = (
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block"><span className="mb-1 block text-sm font-semibold">New password</span><input name="password" type="password" required minLength={10} autoComplete="new-password" className="field" /><span className="mt-1 block text-xs text-slate">At least 10 characters.</span></label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Confirm new password</span><input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="field" />{fieldError && <span role="alert" className="mt-1 block text-xs text-danger">{fieldError}</span>}</label>
        {error && <Notice tone="danger" title="Couldn't change the password">{error}</Notice>}
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
      </form>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
        <h1 className="mt-4 mb-6 font-display text-4xl font-semibold">Choose a new password</h1>
        {body}
      </div>
    </main>
  );
}
