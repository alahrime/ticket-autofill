# shop-web

The TypeScript (Express 5, `node:sqlite`) port of the shop's Python ticket server (`shop.py`), in an Nx monorepo.

- `apps/api` - the Express server (listens on `127.0.0.1:8081`)
- `libs/domain` - pure domain code, imported as `@shop/domain`

```
npm ci
npx nx test api
npx nx build api
npx nx run-many -t lint typecheck test build
```

`node:sqlite` runs fine under Jest (see `apps/api/test/sqlite.spec.ts`), so `better-sqlite3` is not needed.

## On the shop PC

- `start-shop.bat` (repo root) runs `tools/run-shop.cmd`, which starts `node <repo>\shop-web\apps\api\dist\main.js` from the repo root with `UV_THREADPOOL_SIZE=8`. When it exits it logs a line in `shop.log` and starts it again after a back-off (5 s, doubling after each run under a minute, up to 5 min; back to 5 s after a longer run); exit code 3 (the port is taken) is retried twice, 10 s apart, then stops the loop. `start-shop.bat` first waits up to ~10 s for nothing to listen on 8081. The server exits 1 after an uncaught exception (R13) and writes `started <host:port>` in `shop.log` at each start. `start-shop.bat python` starts `shop.py` instead (the rollback); the daily copy uses SQLite's backup (`.tmp`, then renamed).
- `node tools/switch-check.mjs` builds the api, runs `nx run-many -t test`, the parity guard and every `tests/test_*.py`, then starts the built `main.js` on a throwaway root and a spare port (never 8081) and checks `GET /`, the contract, one-server-per-port against both servers (exit 3), and the walk-up to `shop.py`. It prints `ready` only when everything passes.

## Import InvoMax

`node shop-web/apps/api/dist/main.js import-invomax` copies InvoMax's `INVOICE.btv` and `DETAIL.btv` (read-only; InvoMax's folder is never written) into `invomax-import/`, decodes them and upserts into `invomax.db` (WAL; TS-only). A torn copy is retried 3 times, a minute apart. The command prints the counts; `shop.log` gets counts only. InvoMax's folder is `C:\hunni\files`, or `invomaxDir` in `shop-settings.json` (repo root, git-ignored), or the `INVOMAX_DIR` environment variable.

## Backups

`backup.ts` makes `backups/tickets-YYYY-MM-DD.db` (and `invomax-YYYY-MM-DD.db` when `invomax.db` exists) with SQLite's online backup (`.tmp`, `quick_check`, then renamed); the nightly schedule is wired separately. Retention: the newest 90 tickets files; for InvoMax the newest 14 daily plus the first file of each of the newest 24 months. Only files named exactly like that are ever deleted.

- `node shop-web/apps/api/dist/main.js copy-backups E:` copies the backups to `E:\shop-backups` (skipping files already there with the same size) and records it in `backups/offsite.json` once every file is there. A missing drive is refused.
- `node shop-web/apps/api/dist/main.js restore backups/tickets-2026-11-20.db` (or an `invomax-` file) replaces `tickets.db` / `invomax.db` after checking the backup. Stop the shop server first (it refuses while anything listens on the port). The old file and its `-wal`/`-shm` are kept as `<name>.before-restore-YYYYMMDD-HHMMSS`.
- `start-shop.bat`'s daily `tickets-backup-*.db` copy stays as the safety net for the rollback path (`start-shop.bat python`); the two do not interfere.

## Parity guard

While both servers exist, `tools/parity-guard.mjs` keeps them in step. `PARITY` lists the git blob hash of `shop.py`, `tickets.py`, `accounts.py` and `pinweb.py`. CI runs `node tools/parity-guard.mjs` and fails if any of them differs. When it does, port the Python change to `shop-web`, then run `node tools/parity-guard.mjs --update` and commit the new `PARITY`.
