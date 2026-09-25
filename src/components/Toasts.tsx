import { useStore } from '../state/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  // Newest three only; older ones are still dismissed on their timers.
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.slice(-3).map((t) => (
        <button key={t.id} className="toast" onClick={() => dismiss(t.id)}>
          <span className={`lamp ${t.kind === 'run' ? 'run' : t.kind === 'fault' ? 'fault' : 'signal'}`} />
          {t.text}
        </button>
      ))}
    </div>
  );
}
