// Focus for the modal sheets (EXPORT, BATCH, DIAG, ...). When one opens,
// focus moves onto the sheet itself, not onto a button, so Space stays the
// transport until a button is chosen with Tab; when it closes, focus goes
// back to wherever it was, or, if that went with the sheet's work (the
// button that opened it is gone, or sits under a sheet that took over), to
// the sheet still open, or to the console control the first sheet was
// opened from.
import { useEffect, useRef } from 'react';

/** What had the focus before the first of a run of sheets opened. */
let opener: HTMLElement | null = null;

const reachable = (el: HTMLElement | null): el is HTMLElement =>
  !!el && el.isConnected && el !== document.body && !el.closest('[inert]');

export function useSheetFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    // From the console (not from inside another sheet): the place to come
    // back to when the last sheet closes, however many hand over meanwhile.
    if (before && before !== document.body && !before.closest('.dialog')) opener = before;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (reachable(before)) {
        before.focus({ preventScroll: true });
        return;
      }
      const sheets = [...document.querySelectorAll<HTMLElement>('.dialog[role="dialog"]')];
      const top = sheets.reverse().find((d) => d !== ref.current && reachable(d));
      if (top) top.focus({ preventScroll: true });
      else if (reachable(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);
  return ref;
}
