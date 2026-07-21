/**
 * A Jina 403/451 describes the requested origin, not the caller's Jina API
 * credentials. Mark it as a selector-local skip so circuit.ts does not suppress
 * every later URL for the investigation.
 */
export function isJinaOriginBlockStatus(status: number): boolean {
  return status === 403 || status === 451;
}
