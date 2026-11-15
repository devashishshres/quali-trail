import { STATEMENT_TEXT } from "@/lib/server/signoff/statement";
import { allow, clientIp, featureOn, gone, guarded, json, off, rpc, sessionHash, tokenHash, tooMany } from "@/lib/server/signoff/service";
import type { SnapshotResponse } from "@/lib/types";

/** POST /api/signoff/snapshot — the job snapshot. Needs the link token AND a code-verified session. */
async function handlePOST(request: Request) {
  if (!featureOn()) return off();
  if (!(await allow("snapshot-ip", await clientIp(), 600, 60))) return tooMany();
  const [th, sh] = [await tokenHash(request), await sessionHash()];
  if (!th || !sh) return gone();
  const r = await rpc("signoff_read_snapshot", { p_token_hash: th, p_session_hash: sh });
  if (!r.ok) return gone();
  const s = r.snapshot as Record<string, unknown>;
  const body: SnapshotResponse = {
    status: r.status as SnapshotResponse["status"],
    deliveryMode: r.deliveryMode as SnapshotResponse["deliveryMode"],
    snapshot: {
      workerName: String(s.workerName),
      type: String(s.type),
      title: String(s.title),
      date: (s.date as string | null) ?? null,
      issuer: (s.issuer as string | null) ?? null,
      skills: (s.skills as string[]) ?? [],
      activities: (s.activities as string[]) ?? [],
      equipment: (s.equipment as string[]) ?? [],
      summary: (s.summary as string | null) ?? null,
    },
    statement: STATEMENT_TEXT,
    response: (r.response as SnapshotResponse["response"]) ?? null,
  };
  return json(body);
}

export const POST = guarded(handlePOST);
