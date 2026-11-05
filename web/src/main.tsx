// Stylesheets before any component: index.css declares the layer order (theme, base, app, …). A component's own
// `@layer app` file bundled ahead of it would make `app` the first, weakest layer, and Tailwind's reset (base) would
// then beat every app rule (test/cssOrder.test.ts).
import './index.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/Diagnostics.tsx';
import { LANG } from './i18n.ts';

// the page's language, for screen readers and fonts (the chosen one, i18n.ts)
document.documentElement.lang = LANG;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
