/**
 * A callback ref that moves focus to its element once, when it mounts
 * (ENG-37): a form's outcome — "Request received", "Not sent", "Check your
 * inbox" — replaces the button that was pressed, and without this focus would
 * fall back to `<body>`, so a keyboard user starts again from the top and a
 * screen reader may say nothing. The element needs `tabIndex={-1}`.
 *
 * A module-level function, so its identity never changes: React calls a
 * callback ref again whenever a new function is passed, and an inline one
 * would pull focus back to the message on every keystroke elsewhere.
 */
export function focusOnMount(node: HTMLElement | null): void {
  node?.focus()
}
