export const DELETE_CONFIRM_PHRASE = "DELETE";

/** Type-to-confirm gate for the irreversible account-deletion action (case/whitespace-insensitive). */
export function isDeleteConfirmed(text: string): boolean {
  return text.trim().toUpperCase() === DELETE_CONFIRM_PHRASE;
}
