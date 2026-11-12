// The Jamware schematic-record mark: platter, grooves, crosshair ticks,
// signal-orange square spindle. Strokes follow the current text colour.
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-label="Jamware">
      <circle cx="32" cy="32" r="24" stroke="currentColor" strokeWidth="3" />
      <circle cx="32" cy="32" r="18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="13" stroke="currentColor" strokeWidth="1.5" />
      <rect x="28" y="28" width="8" height="8" fill="#FF4D00" />
      <path d="M32 1v4M32 59v4M1 32h4M59 32h4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
