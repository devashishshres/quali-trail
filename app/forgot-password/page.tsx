"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Notice } from "@/components/ui/states";
import { authRequest } from "@/lib/client/auth-api";
import { toApiError } from "@/lib/client/errors";

const LINK_PROBLEM: Record<string, { title: string; body: string }> = {
  expired: { title: "That reset link has expired or was already used", body: "Request a new link below. Each link works once, for one hour." },
  browser: { title: "Open the reset link in the browser where you asked for it", body: "For your security the link only works in the browser that requested it. Request a new link here, or open the email on the device you used." },
};

function ForgotForm() {
  const problem = LINK_PROBLEM[useSearchParams().get("error") ?? ""];
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authRequest<{ message: string }>("/api/auth/recover", { email: new FormData(e.currentTarget).get("email") });
      setSent(r.message);
    } catch (x) {
      setError(toApiError(x).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <div className="mt-6"><Notice title="Check your email">{sent}</Notice></div>;
  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      {problem && <Notice tone="danger" title={problem.title}>{problem.body}</Notice>}
      <p className="text-sm text-slate">Enter the address you sign in with. If it has an account, we&apos;ll email a link to choose a new password.</p>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Email</span><input name="email" type="email" required autoComplete="email" className="field" /></label>
      {error && <Notice tone="danger" title="Couldn't send the link">{error}</Notice>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Sending…" : "Email me a reset link"}</button>
      <p className="text-sm text-slate"><Link href="/sign-in" className="font-semibold underline">Back to sign in</Link></p>
    </form>
  );
}

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
        <h1 className="mt-4 font-display text-4xl font-semibold">Reset your password</h1>
        <Suspense fallback={null}><ForgotForm /></Suspense>
      </div>
    </main>
  );
}
