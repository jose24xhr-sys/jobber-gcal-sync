/**
 * Jobber IDs are EncodedId: base64 of a global ID, e.g. "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMTkxOTUzNDA" ->
 * "gid://Jobber/Client/119195340" (docs: "Object IDs (EncodedId)"). We use this only as an extra guard:
 * if an ID clearly decodes to a non-Visit type, it is never synced.
 */
export function decodeEncodedId(id: string): { type: string; numericId: string } | null {
  try {
    const decoded = atob(id);
    const m = /^gid:\/\/Jobber\/([A-Za-z]+)\/(\d+)$/.exec(decoded);
    return m ? { type: m[1]!, numericId: m[2]! } : null;
  } catch {
    return null;
  }
}

/** True when the ID decodes to a type other than `expected`. Undecodable IDs return false (no evidence). */
export function isDefinitelyNot(id: string, expected: string): boolean {
  const d = decodeEncodedId(id);
  return d !== null && d.type !== expected;
}
