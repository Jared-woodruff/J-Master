// Focus for the modal sheets (EXPORT, BATCH, DIAG, ...). When one opens,
// focus moves onto the sheet itself, not onto a button, so Space stays the
// transport until a button is chosen with Tab; when it closes, focus goes
// back to wherever it was.
import { useEffect, useRef } from 'react';

export function useSheetFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);
  return ref;
}
