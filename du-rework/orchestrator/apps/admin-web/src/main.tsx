import { StrictMode } from 'react';
import { RouterProvider } from 'react-router';
import { createRoot } from 'react-dom/client';
import { router } from '@/router';
import '@/styles/app.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Orchestrator Portal root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
