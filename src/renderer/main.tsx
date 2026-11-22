import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/global.css';
import { App } from './App';
import { UpdateGate } from './components/UpdateGate';
import { useApp, useChats } from './store/app';
import { useEditor } from './store/editor';
import { api } from './lib/api';

if (window.lunarixTest) {
  (window as any).__lx = { useApp, useChats, useEditor, api };
}

window.addEventListener('error', (e) => console.error('[renderer]', e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => console.error('[renderer] unhandled', e.reason));

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <UpdateGate />
  </>
);
