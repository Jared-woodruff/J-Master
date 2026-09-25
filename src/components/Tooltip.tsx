// One tooltip for the whole app, in the Jamware style. It reads the plain
// `title` attributes components already set: while an element is hovered
// (or keyboard-focused) its title moves to data-tip so the slow native
// tooltip never appears, and it is restored on leave so the accessible
// description is unchanged. Segments after " · " render as a meta line,
// with key names shown as key caps.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Tip {
  text: string;
  x: number;       // anchor centre
  top: number;     // anchor top edge
  bottom: number;  // anchor bottom edge
}

const SHOW_MS = 450;
const WARM_MS = 700;   // after one tooltip closes, the next opens fast
const KEY_RE = /^(?:(?:Ctrl|Shift|Alt)\+)?(?:[A-Z0-9?]|Space|Home|Enter|Esc|←|→|↑|↓)$/;

function renderTip(text: string) {
  const [main, ...rest] = text.split(' · ');
  return (
    <>
      <span className="tipmain">{main}</span>
      {rest.length > 0 && (
        <span className="tipmeta">
          {rest.map((seg, i) => (
            <span key={i}>
              {i > 0 && <span className="tipsep"> · </span>}
              {KEY_RE.test(seg.trim()) ? <kbd>{seg.trim()}</kbd> : seg}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer = 0;
    let lastHidden = 0;

    const strip = (el: HTMLElement) => {
      const t = el.getAttribute('title');
      if (t) { el.dataset.tip = t; el.removeAttribute('title'); }
    };
    const restore = (el: HTMLElement) => {
      if (el.dataset.tip && !el.hasAttribute('title')) el.setAttribute('title', el.dataset.tip);
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) restore(current);
      current = null;
      setTip((t) => {
        if (t) lastHidden = performance.now();
        return null;
      });
    };
    const show = (el: HTMLElement) => {
      if (!el.isConnected || !el.dataset.tip) return;
      const r = el.getBoundingClientRect();
      setTip({ text: el.dataset.tip, x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
    };
    const arm = (el: HTMLElement, delay: number) => {
      if (current && current !== el) restore(current);
      current = el;
      strip(el);
      window.clearTimeout(timer);
      setTip(null);
      const warm = performance.now() - lastHidden < WARM_MS;
      timer = window.setTimeout(() => show(el), warm ? 60 : delay);
    };
    const tipTarget = (node: EventTarget | null) =>
      ((node as Element | null)?.closest?.('[title], [data-tip]') as HTMLElement | null) ?? null;

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el === current) return;
      if (!el) { if (current) hide(); return; }
      arm(el, SHOW_MS);
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element;
      if (!target?.matches?.(':focus-visible')) return;
      const el = tipTarget(target);
      if (el) arm(el, 250);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKey);
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('wheel', hide, { passive: true });
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('wheel', hide);
    };
  }, []);

  // Place below the anchor (above if there's no room), clamped on-screen.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !tip) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - w - margin, tip.x - w / 2));
    const below = tip.bottom + 8;
    const top = below + h + margin > window.innerHeight ? Math.max(margin, tip.top - 8 - h) : below;
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    box.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={boxRef} className="tip" role="tooltip" style={{ visibility: 'hidden' }}>
      {renderTip(tip.text)}
    </div>
  );
}
