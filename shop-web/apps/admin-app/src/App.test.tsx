import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockFetch, renderWithClient } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('routes /bills to Bill history, with Back to tickets in the header', async () => {
    mockFetch((_m, url) => (url === '/api/needs-bill' ? [200, { tickets: [] }] : [200, { rows: [], total: 0, page: 1, per_page: 50 }]));
    window.history.replaceState(null, '', '/bills');
    renderWithClient(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Bill history' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to tickets' })).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('link', { name: 'Bill history' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Bill history - Shop admin');
  });

  it('routes /jobs to the job mapping placeholder', () => {
    mockFetch(() => undefined);
    window.history.replaceState(null, '', '/jobs');
    renderWithClient(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Job mapping' })).toBeInTheDocument();
  });

  it('routes /bills/<no>/print to the bare print page: no header', async () => {
    mockFetch(() => undefined);
    vi.stubGlobal('print', vi.fn());
    window.history.replaceState(null, '', '/bills/9000010/print?noprint=1');
    renderWithClient(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByRole('link', { name: 'Back to tickets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  it('anything else says so', () => {
    mockFetch(() => undefined);
    window.history.replaceState(null, '', '/app/x');
    renderWithClient(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });
});
