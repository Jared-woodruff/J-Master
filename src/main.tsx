import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Scripting/testing hook: the store and engine, reachable from DevTools.
// Everything runs locally, so exposing it costs nothing and enables the
// automated verification suite and power-user scripting.
void Promise.all([
  import('./state/store'),
  import('./audio/engine'),
  import('./audio/flac'),
]).then(([{ useStore, chainParamsFrom }, { engine }, flac]) => {
  (window as any).__jmaster = {
    store: useStore,
    engine,
    chainParams: () => chainParamsFrom(useStore.getState()),
    flac,
  };
});
