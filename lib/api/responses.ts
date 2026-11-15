import "server-only";
import { NextResponse } from "next/server";
import type { ApiError } from "../types";

type ErrorCode = ApiError["error"]["code"];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  unsupported_file: 415,
  file_too_large: 413,
  duplicate_evidence: 409,
  extraction_failed: 502,
  memory_unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

/** Consistent error body for every route. Never put secrets or file contents in `message`. */
export function apiError(
  code: ErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): NextResponse<ApiError> {
  return NextResponse.json(
    { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } },
    { status: STATUS_BY_CODE[code], headers: { "Cache-Control": "no-store" } },
  );
}

export function ok<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
