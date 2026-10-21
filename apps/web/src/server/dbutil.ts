import type { ResultSetHeader } from "mysql2";

/** mysql2 error code (e.g. `ER_DUP_ENTRY`), looking through wrapper errors. */
export function dbErrorCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; i++) {
    if (typeof e.code === "string" && e.code.startsWith("ER_")) return e.code;
    e = e.cause as typeof e;
  }
  return undefined;
}

export const isDuplicate = (err: unknown): boolean => dbErrorCode(err) === "ER_DUP_ENTRY";

/** Rows matched/changed by an UPDATE or DELETE run through drizzle's mysql2 driver. */
export function affectedRows(result: unknown): number {
  const header = (Array.isArray(result) ? result[0] : result) as ResultSetHeader | undefined;
  return header?.affectedRows ?? 0;
}

export const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes);
