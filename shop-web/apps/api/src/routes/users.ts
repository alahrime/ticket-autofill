// User admin (shop.py: get()'s /api/mechanics and /api/users, post()'s /api/users, user()). Admin only: a
// mechanic gets 403 before any body is read, as Python's refuse().
import { type RequestHandler, Router } from 'express';
import { checkNewSecret, Locked, LoginFailed } from '../accounts';
import { BadInput } from '../errors';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { clientIp, jsonBody, sessionCookie } from '../http/security';
import { sessionIn, signedIn } from '../view';

const ID = /^[0-9]{1,9}$/;

type Body = Record<string, unknown>;

/** On to the next route (in the end, the 404) unless :id is 1 to 9 digits; before any body is read. */
const validId: RequestHandler = (req, _res, next) => {
  const id = req.params['id'];
  next(typeof id === 'string' && ID.test(id) ? undefined : 'route');
};

export function userRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const admin = signedIn('admin');

  r.get('/api/mechanics', admin, (req, res) => {
    res.json({ mechanics: depsOf(req).accounts.list('mechanic', true).map((u) => u.name) });
  });
  r.get('/api/users', admin, (req, res) => {
    res.json({ users: depsOf(req).accounts.list() });
  });
  r.post('/api/users', admin, jsonBody, validRequest, async (req, res) => {
    const d = req.body as Body;
    res.json(await depsOf(req).accounts.add(d['name'], d['role'], d['secret']));
  });

  // {secret} resets their PIN/password, {active: bool} turns them on or off. Everything is checked before
  // anything is written: no half-applied change.
  r.post('/api/users/:id', admin, validId, jsonBody, validRequest, async (req, res) => {
    const { accounts } = depsOf(req);
    const s = sessionIn(res);
    const d = req.body as Body;
    const id = Number(req.params['id']);
    const u = accounts.get(id);
    if (!u) return void res.status(404).json({ error: 'no such user' });
    const hasActive = Object.hasOwn(d, 'active');
    const hasSecret = Object.hasOwn(d, 'secret');
    if (hasActive && typeof d['active'] !== 'boolean') throw new BadInput('active must be true or false');
    if (hasSecret) checkNewSecret(u.role, d['secret']);
    // the last-admin rule is checked before its write; the secret can't fail now
    if (hasActive) accounts.setActive(id, d['active'] as boolean);
    if (hasSecret) {
      const secret = d['secret'] as string;
      await accounts.setSecret(id, secret);
      if (id === s.user_id && d['active'] !== false) {
        // own password: every session went; sign this device back in
        try {
          const { token } = await accounts.login(s.name, secret, 'admin', clientIp(req));
          res.setHeader('Set-Cookie', sessionCookie(token, 'admin', req));
        } catch (e) {
          if (!(e instanceof LoginFailed || e instanceof Locked)) throw e;
        }
      }
    }
    res.json(accounts.get(id));
  });
  return r;
}
