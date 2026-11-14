import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import { App } from './App.tsx';
import { useAppStore } from './store.ts';

// Dev only: poke the store from the console, e.g. __marcia.getState().setWalk({ pathIdx: 80, oxygenLeftMin: 120 }).
if (import.meta.env.DEV) (window as unknown as { __marcia?: typeof useAppStore }).__marcia = useAppStore;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
