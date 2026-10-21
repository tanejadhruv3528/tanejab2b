import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import './styles.css';

// Demo builds answer API calls in the browser with sample data (see demo.ts); normal builds never load it.
if (import.meta.env.VITE_DEMO === 'true') {
  const { installDemoApi } = await import('./demo');
  installDemoApi();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

// The service worker only caches the app shell so it opens offline; API responses are never cached.
if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_DEMO !== 'true') {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
