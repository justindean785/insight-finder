/**
 * The composer's ONE primary action, decided in one place.
 *
 * The workspace used to show two competing primaries on a finished case: a white
 * "Continue" in a run-controls row above the composer, and a "Start
 * investigation" button inside it — on a case that had already started, with a
 * placeholder asking for a brand-new seed. An analyst could not tell whether
 * typing continued this case or began another.
 *
 * Now the button says what it will do:
 *   - a run is live           → Stop
 *   - no case yet             → Start investigation
 *   - open case, empty box    → Continue (one more cycle), when a cycle may run
 *   - open case, text typed   → Send (a follow-up on THIS case)
 * Send semantics are unchanged: a follow-up always went to this thread.
 */
export type ComposerPrimary =
  | { kind: "stop"; stopping: boolean }
  | { kind: "continue" }
  | { kind: "start"; disabled: boolean }
  | { kind: "send"; disabled: boolean };

export function composerPrimary(input: {
  isLoading: boolean;
  stopping: boolean;
  isFollowUp: boolean;
  /** A next cycle may start now (`canShowRunControls` and not loading). */
  canContinue: boolean;
  /** No text and no attachments. */
  empty: boolean;
  canSubmit: boolean;
  uploading: boolean;
}): ComposerPrimary {
  if (input.isLoading) return { kind: "stop", stopping: input.stopping };
  if (!input.isFollowUp) return { kind: "start", disabled: !input.canSubmit || input.uploading };
  if (input.empty && input.canContinue) return { kind: "continue" };
  return { kind: "send", disabled: !input.canSubmit || input.uploading };
}
