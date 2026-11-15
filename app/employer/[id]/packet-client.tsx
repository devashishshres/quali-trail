"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PacketView } from "@/components/employer/packet-view";
import { reviewerApi } from "@/lib/client/employer-api";
import { toApiError } from "@/lib/client/errors";
import { formatStamp } from "@/lib/client/labels";
import { useLoad } from "@/lib/client/use-load";
import { ErrorNotice, Loading } from "@/components/ui/states";

export function PacketClient() {
  const { id } = useParams<{ id: string }>();
  const r = useLoad(() => reviewerApi.get(id), id);
  const [message, setMessage] = useState<string | null>(null);

  async function openOriginal(record: string) {
    setMessage(null);
    try {
      const { url } = await reviewerApi.document(id, record);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setMessage(toApiError(e).message);
    }
  }

  if (r.status === "loading") return <Loading label="Loading the packet…" />;
  if (r.error) return <><ErrorNotice error={r.error} /><Link className="btn btn-quiet mt-4" href="/employer">Back to shared packets</Link></>;
  const s = r.data!;
  return (
    <div className="space-y-4">
      <p className="no-print rounded-md bg-paper px-4 py-3 text-sm text-slate">
        Shared with you {formatStamp(s.sharedAt)}; access ends {formatStamp(s.expiresAt)} unless withdrawn sooner. This packet is a fixed copy
        made when it was shared. Your access confirms only that you control the email address it was sent to.
      </p>
      {message && <p role="alert" className="text-sm text-danger">{message}</p>}
      <div className="sheet p-5 sm:p-8">
        <PacketView packet={s.packet} changedRecordIds={s.changedRecordIds} onOpenOriginal={openOriginal} />
      </div>
      <p className="text-xs text-slate">Packet fingerprint (SHA-256): <span className="break-all font-mono">{s.packetHash}</span></p>
      <Link className="btn btn-quiet no-print" href="/employer">Back to shared packets</Link>
    </div>
  );
}
