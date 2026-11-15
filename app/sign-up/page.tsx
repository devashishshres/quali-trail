"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Notice } from "@/components/ui/states";
import { ApiRequestError, toApiError } from "@/lib/client/errors";

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(json?.error?.code ?? "internal", res.status, json?.error?.message ?? "Something went wrong.", json?.error?.fieldErrors);
  return json;
}

function SignUpForm() {
  const next = useSearchParams().get("next");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const r = await post("/api/auth/signup", { email: f.get("email"), password: f.get("password"), next: next ?? undefined });
      setSent(r.message);
    } catch (x) {
      setError(toApiError(x).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-6 space-y-4">
        <Notice title="Check your email">{sent}</Notice>
        <p className="text-sm text-slate">The link confirms your address and brings you back here to set up your profile.</p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <p className="text-sm text-slate">QualiTrail is in a limited preview. Accounts are open to invited people and approved addresses.</p>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Email</span><input name="email" type="email" required autoComplete="email" className="field" /></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Password</span><input name="password" type="password" required minLength={10} autoComplete="new-password" className="field" /><span className="mt-1 block text-xs text-slate">At least 10 characters.</span></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Confirm password</span><input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="field" /></label>
      {error && <Notice tone="danger" title="Couldn't create the account">{error}</Notice>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      <p className="text-sm text-slate">Already have an account? <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} className="font-semibold underline">Sign in</Link></p>
    </form>
  );
}

export default function SignUpPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
        <h1 className="mt-4 font-display text-4xl font-semibold">Create an account</h1>
        <Suspense fallback={null}><SignUpForm /></Suspense>
      </div>
    </main>
  );
}
