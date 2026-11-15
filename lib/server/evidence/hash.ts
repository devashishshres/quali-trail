import { createHash } from "node:crypto";

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Manual entries hash their normalised text so retyping the same note is a duplicate. */
export const hashText = (text: string) => sha256(text.replace(/\s+/g, " ").trim().toLowerCase());

/** True for real PDF bytes: the magic header, not just a claimed content type. */
export const looksLikePdf = (bytes: Uint8Array) =>
  bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
