// Focus for the modal sheets (EXPORT, BATCH, DIAG, ...). When one opens,
// focus moves onto the sheet itself, not onto a button, so Space stays the
// transport until a button is chosen with Tab; when it closes, focus goes
// back to wherever it was, or, if that went with the sheet's work (the
// button that opened it is gone), to the sheet still open under it.
import { useEffect, useRef } from 'react';

export function useSheetFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) {
        before.focus({ preventScroll: true });
        return;
      }
      const sheets = [...document.querySelectorAll<HTMLElement>('.dialog[role="dialog"]')];
      sheets.reverse().find((d) => d !== ref.current)?.focus({ preventScroll: true });
    };
  }, [open]);
  return ref;
}
