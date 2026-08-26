import { useStore } from '../state/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button key={t.id} className="toast" onClick={() => dismiss(t.id)}>
          <span className={`lamp ${t.kind === 'run' ? 'run' : t.kind === 'fault' ? 'fault' : 'signal'}`} />
          {t.text}
        </button>
      ))}
    </div>
  );
}
