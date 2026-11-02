import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/Diagnostics.tsx';
import { LANG } from './i18n.ts';
// Tailwind + shadcn theme first; the app's own stylesheet (unlayered) keeps priority over Tailwind's layers.
import './index.css';
import './styles.css';

// the page's language, for screen readers and fonts (the chosen one, i18n.ts)
document.documentElement.lang = LANG;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
