// Server-rendered pages (pinweb.page, shop.py's sign_in, setup_page, CHOOSER, web_page): no data on them, and
// every value put in is escaped.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { Locked } from '../accounts';

export const HTML = 'text/html; charset=utf-8';
export const TITLE = 'Shop tickets';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/** Python's html.escape(s, quote=True). */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

/** A whole page: title escaped, body is HTML. */
export function page(title: string, body: string): string {
  const t = escapeHtml(title);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:40px 16px;background:#f4f4f4;color:#222;text-align:center}
input,button,a.big{font:inherit;font-size:22px;padding:12px;border-radius:8px;width:100%;max-width:280px;box-sizing:border-box}
input{border:1px solid #ccc;text-align:center;letter-spacing:4px;margin:12px 0} button,a.big{border:0;background:#1f5fbf;color:#fff}
a.big{display:inline-block;margin:10px 0;text-decoration:none} p.err{color:#b00}</style></head><body>
<h1>${t}</h1>
${body}
</body></html>`;
}

/** The front page: one link per sign-in (the check-in kiosk is retired). */
export const CHOOSER = page(TITLE, '<a class="big" href="/tech">Mechanic</a><br><a class="big" href="/admin">Admin</a>');

/** The sign-in page for a page's role, with an error line and the name typed (both escaped). */
export function signInPage(role: 'admin' | 'mechanic', msg = '', name = ''): string {
  const admin = role === 'admin';
  const secret = admin
    ? '<input type="password" name="secret" autocomplete="current-password" placeholder="Password" required>'
    : '<input type="password" name="secret" inputmode="numeric" pattern="[0-9]*" ' +
      'autocomplete="current-password" placeholder="PIN" required>';
  return page(
    admin ? 'Shop admin' : 'Mechanic sign-in',
    `<form method="post" action="/login/${admin ? 'admin' : 'tech'}">
<input name="name" autocomplete="username" placeholder="${admin ? 'Username' : 'Name'}" value="${escapeHtml(name)}"
autocapitalize="words" autofocus required><br>${secret}<br><button>Sign in</button></form><p class="err">${escapeHtml(msg)}</p>`,
  );
}

/** First run: the setup-code form. */
export function setupPage(msg = '', name = ''): string {
  return page(
    'Shop setup',
    `<p>No admin yet. Type the code from setup_code.txt on the shop PC.</p>
<form method="post" action="/setup"><input name="code" autocomplete="off" placeholder="Setup code" required><br>
<input name="name" autocomplete="username" placeholder="Username" value="${escapeHtml(name)}" required><br>
<input type="password" name="password" autocomplete="new-password" placeholder="Password (10+ characters)" required><br>
<input type="password" name="again" autocomplete="new-password" placeholder="Password again" required><br>
<button>Make admin</button></form><p class="err">${escapeHtml(msg)}</p>`,
  );
}

/** The sign-in page's line for a Locked. */
export function waitMessage(e: Locked): string {
  if (e.busy) return 'The server is busy. Try again in a few seconds.';
  if (e.retryAfter > 90 * 60) return `Too many tries. Wait ${Math.ceil(e.retryAfter / 3600)} hours.`;
  return `Too many tries. Wait ${Math.ceil(e.retryAfter / 60)} min.`;
}

/** web/<name>.html read fresh each time (edit and reload); a placeholder until it's built. name is ours, never the URL's. */
export async function webPage(webDir: string, name: 'admin' | 'tech'): Promise<Buffer | string> {
  try {
    return await readFile(join(webDir, `${name}.html`));
  } catch {
    return page('Not built yet', `<p>The ${name} page isn't built yet.</p><p><a href="/">Back</a></p>`);
  }
}

export function sendHtml(res: Response, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.status(status).set(headers).set('Content-Type', HTML).send(body);
}

/** An empty redirect (as shop.py: text/plain, no body), with any extra headers. */
export function redirect(res: Response, status: 302 | 303, to: string, headers: Record<string, string> = {}): void {
  res.status(status).set(headers).set({ Location: to, 'Content-Type': 'text/plain' }).send('');
}
