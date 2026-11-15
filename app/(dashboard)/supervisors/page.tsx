"use client";
import { useState } from "react";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { formatDate } from "@/lib/client/labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";

const STATUS: Record<string, string> = { pending: "Invitation sent", accepted: "Connected", declined: "Declined", revoked: "Ended", expired: "Expired" };

export default function SupervisorsPage() {
  const list = useLoad(accountsApi.supervisors);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "info"; text: string } | null>(null);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ tone: "info", text: done });
      list.reload();
    } catch (e) {
      setMessage({ tone: "danger", text: toApiError(e).message });
    } finally {
      setBusy(false);
    }
  }
  const invite = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    return act(async () => { await accountsApi.inviteSupervisor(email); form.reset(); }, "Invitation sent.");
  };

  return (
    <>
      <PageHeader title="Supervisors" lede="People who can review completed jobs you send them. They see only what you send, and either of you can end the connection." />
      {list.status === "loading" && <Loading label="Loading…" />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && !list.data.enabled && <Notice title="Not available">Supervisor review is switched off on this server.</Notice>}
      {list.data?.enabled && (
        <div className="space-y-8">
          {list.data.mode === "mock" && (
            <p role="status" className="rounded-md border-2 border-dashed border-orange bg-orange-wash px-3 py-2 text-sm font-semibold text-orange-ink">
              SIMULATED email: invitations are written to a local developer outbox, not sent.
            </p>
          )}
          <form onSubmit={invite} className="sheet space-y-3 p-5 sm:p-7">
            <h2 className="font-display text-2xl font-semibold">Invite a supervisor</h2>
            <p className="text-sm text-slate">They&apos;ll get an email and must sign in with that same address to accept. Accepting confirms they control the address; it does not verify their job or credentials.</p>
            <label className="block max-w-md"><span className="mb-1 block text-sm font-semibold">Their email</span><input name="email" type="email" className="field" required maxLength={320} /></label>
            <label className="flex gap-2 text-sm"><input type="checkbox" required /> This person agreed to be contacted by QualiTrail.</label>
            <button className="btn btn-primary" disabled={busy || !list.data.canSend}>{busy ? "Sending…" : "Send invitation"}</button>
            {!list.data.canSend && <p className="text-sm text-slate">Email isn&apos;t configured on this server yet.</p>}
          </form>
          {message && <Notice tone={message.tone === "danger" ? "danger" : undefined} title={message.tone === "danger" ? "Something went wrong" : "Done"}>{message.text}</Notice>}
          <section>
            <h2 className="border-b-2 border-navy pb-2 font-display text-2xl font-semibold">Your supervisors</h2>
            {list.data.relationships.length === 0 && <p className="py-6 text-slate">No supervisors yet.</p>}
            <ul className="divide-y divide-line">
              {list.data.relationships.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-semibold">{r.supervisorName ?? r.emailHint ?? "Invitation"}</p>
                    <p className="text-sm text-slate">
                      {STATUS[r.status] ?? r.status}
                      {r.status === "accepted" && r.acceptedAt && ` on ${formatDate(r.acceptedAt.slice(0, 10))}`}
                      {r.status === "pending" && ` · expires ${formatDate(r.expiresAt.slice(0, 10))}`}
                      {r.supervisorTitle || r.supervisorOrganization ? ` · ${[r.supervisorTitle, r.supervisorOrganization].filter(Boolean).join(", ")} (as they entered it, not verified)` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {r.status === "pending" && <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => accountsApi.remindInvite(r.id), "Reminder sent.")}>Send reminder</button>}
                    {(r.status === "pending" || r.status === "accepted") && (
                      <button className="btn btn-quiet" disabled={busy} onClick={() => confirm(r.status === "accepted" ? "End this connection? Pending reviews will be withdrawn; completed reviews are kept." : "Cancel this invitation?") && act(() => accountsApi.revokeRelationship(r.id), "Done.")}>
                        {r.status === "accepted" ? "End connection" : "Cancel invitation"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
