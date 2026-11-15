import type { ApiError } from "@/lib/types";

type ErrorCode = ApiError["error"]["code"];

export class ApiRequestError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public fieldErrors?: Record<string, string[]>,
    /** True when the route itself does not exist yet (HTML 404, no JSON body). */
    public missingEndpoint = false,
  ) {
    super(message);
  }
}

export function toApiError(e: unknown): ApiRequestError {
  return e instanceof ApiRequestError ? e : new ApiRequestError("internal", 0, "Something went wrong. Try again.");
}
