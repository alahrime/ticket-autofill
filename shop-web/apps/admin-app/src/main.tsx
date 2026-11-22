// The admin app's entry: one QueryClient for the page; a reply saying the session is gone goes back to
// /admin to sign in again (the server sends a signed-out /bills there too).
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@shop/api-client';
import { App } from './App';
import './styles.css';

const signedOut = (e: unknown): void => {
  if (e instanceof ApiError && e.status === 401) window.location.assign('/admin');
};

const client = new QueryClient({
  queryCache: new QueryCache({ onError: signedOut }),
  mutationCache: new MutationCache({ onError: signedOut }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // a refusal (4xx) won't change by asking again; a dropped connection might
      retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status < 500),
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
