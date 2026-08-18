import { Logo } from './Logo';

const bridge = (window as any).jmaster;

export function TitleBar() {
  return (
    <header className="titlebar">
      <Logo size={20} />
      <div className="wordmark">
        <span className="display" style={{ fontSize: 15 }}>J-Master</span>
        <span className="spec sub">Mastering Console</span>
      </div>
      <div className="titlebar-spacer" />
      <span className="spec rev">JMW Software · Rev 2.2</span>
      {bridge?.windowControl && (
        <nav className="winbtns" aria-label="Window controls">
          <button className="winbtn" onClick={() => bridge.windowControl('minimize')} aria-label="Minimize">─</button>
          <button className="winbtn" onClick={() => bridge.windowControl('maximize')} aria-label="Maximize">□</button>
          <button className="winbtn close" onClick={() => bridge.windowControl('close')} aria-label="Close">×</button>
        </nav>
      )}
    </header>
  );
}
