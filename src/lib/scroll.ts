// Whose wheel is it? On a wide window nothing scrolls and the wheel can
// turn a knob or zoom the EQ. On a narrow or short one the workspace
// itself scrolls, and a wheel that lands on a control on its way down the
// page must keep scrolling the page.

/** True when an ancestor of `el` can scroll vertically right now. */
export function pageScrollsUnder(el: Element | null): boolean {
  for (let n = el?.parentElement ?? null; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const overflow = getComputedStyle(n).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}
