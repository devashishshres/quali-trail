"use client";
import Link from "next/link";
import { reviewerApi } from "@/lib/client/employer-api";
import { formatStamp } from "@/lib/client/labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading, PageHeader } from "@/components/ui/states";

const STATUS: Record<string, string> = { active: "Open", revoked: "Withdrawn by the technician", expired: "Expired", pending: "Not opened yet" };

export default function EmployerHome() {
  const r = useLoad(reviewerApi.list);
  return (
    <>
      <PageHeader title="Shared packets" lede="Records technicians have shared with your email address. Read-only." />
      {r.status === "loading" && <Loading label="Loading…" />}
      {r.error && <ErrorNotice error={r.error} onRetry={r.reload} />}
      {r.data && r.data.shares.length === 0 && <p className="text-slate">Nothing has been shared with this account yet. Open the link in the email you received to see a packet here.</p>}
      {r.data && r.data.shares.length > 0 && (
        <ul className="sheet divide-y divide-line">
          {r.data.shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <span>
                <span className="block font-semibold">{s.technician ?? "A technician"}</span>
                <span className="block text-sm text-slate">Shared {formatStamp(s.sharedAt)}. {STATUS[s.status] ?? s.status}{s.status === "active" ? ` until ${formatStamp(s.expiresAt)}` : ""}.</span>
              </span>
              {s.status === "active" && <Link className="btn btn-secondary" href={`/employer/${s.id}`}>View</Link>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
