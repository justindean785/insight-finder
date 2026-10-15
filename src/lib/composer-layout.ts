/** Placeholder wrapping is not content and must never enlarge an empty composer. */
export function resizeComposer(element: HTMLTextAreaElement, input: string, phone: boolean): void {
  if (!input) {
    element.style.height = "44px";
    return;
  }
  element.style.height = "auto";
  element.style.height = `${Math.min(Math.max(element.scrollHeight, phone ? 44 : 64), 208)}px`;
}
