// The admin's upkeep buttons: how the backups and the InvoMax import stand, "Check InvoMax now" and
// "Copy backups to the USB drive". Admin only, 403 for a mechanic before any body is read.
import { Router } from 'express';
import { backupHealth } from '../backup';
import { validRequest } from '../http/contract';
import { depsOf } from '../http/deps';
import { jsonBody } from '../http/security';
import { signedIn } from '../view';

export function upkeepRoutes(): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const admin = signedIn('admin');

  r.get('/api/upkeep/status', admin, (req, res) => {
    const { config, history, links, nightly } = depsOf(req);
    res.json({
      backup: backupHealth(config.backups, new Date()),
      import: { running: nightly.running(), last: history.lastImport() },
      needs_bill: links.needsBillCount(),
    });
  });

  r.post('/api/upkeep/import', admin, jsonBody, validRequest, (req, res) => {
    if (depsOf(req).nightly.importNow() === 'running')
      return void res.status(409).json({ error: 'an import is already running' });
    res.status(202).json({ started: true });
  });

  // BadInput: 400 'no USB drive set up' / 'drive not found'; Refused: 409 'a copy is already running'
  r.post('/api/upkeep/copy-backups', admin, jsonBody, validRequest, async (req, res) => {
    res.json({ copies: await depsOf(req).nightly.copyNow() });
  });
  return r;
}
