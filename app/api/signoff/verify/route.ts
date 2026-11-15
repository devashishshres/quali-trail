import { z } from "zod";
import { NextResponse } from "next/server";
import { hmac, newSessionToken } from "@/lib/server/signoff/crypto";
import { NO_STORE, SESSION_COOKIE, allow, clientIp, featureOn, gone, guarded, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

const BAD = () => NextResponse.json({ error: { code: "validation_failed", message: "That code didn't work. Check the newest email, or ask for a new code." } }, { status: 400, headers: NO_STORE });

/** POST /api/signoff/verify { code } — on success sets an HttpOnly session cookie bound to this one invitation. */
async function handlePOST(request: Request) {
  if (!featureOn()) return off();
  const th = await tokenHash(request);
  if (!th) return gone();
  if (!(await allow("verify-ip", await clientIp(), 600, 30)) || !(await allow("verify-token", th, 3600, 20))) return tooMany();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return BAD();

  const session = newSessionToken();
  const r = await rpc("signoff_verify_code", { p_token_hash: th, p_code_hash: hmac("code", `${th}:${body.data.code}`), p_session_hash: hmac("session", session) });
  if (!r.ok) return BAD(); // identical for wrong, expired, used, exhausted, locked or unknown
  const res = NextResponse.json({ verified: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/signoff",
    maxAge: 30 * 60,
  });
  return res;
}

export const POST = guarded(handlePOST);
