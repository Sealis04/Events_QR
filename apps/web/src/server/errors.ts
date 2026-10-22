/** HTTP errors and the JSON response helper, kept free of database and signing imports so the hub can use them. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "invalid_request", message, details);
export const notFound = (what = "not found") => new HttpError(404, "not_found", what);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** `hub` is a device token whose device row is a venue hub. */
