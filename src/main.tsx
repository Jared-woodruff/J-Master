import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/app.css';
import { App } from './App';
import { useStore, chainParamsFrom, reportHtml } from './state/store';
import { engine } from './audio/engine';
import * as flac from './audio/flac';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Scripting/testing hook: the store and engine, reachable from DevTools.
// Everything runs locally, so exposing it costs nothing and enables the
// automated verification suite and power-user scripting.
(window as any).__jmaster = {
  store: useStore,
  engine,
  chainParams: () => chainParamsFrom(useStore.getState()),
  flac,
  report: reportHtml,
};
