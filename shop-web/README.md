# shop-web

The TypeScript (Express 5, `node:sqlite`) port of the shop's Python ticket server (`shop.py`), in an Nx monorepo.

- `apps/api` - the Express server (listens on `127.0.0.1:8081`)
- `libs/domain` - pure domain code, imported as `@shop/domain`
- `apps/admin-app` - the React admin app (Vite, React 19; Bill history at `/bills`, job mapping at `/jobs`)

```
npm ci
npx nx test api
npx nx build api
npx nx run-many -t lint typecheck test build
NX_DAEMON=false npx nx e2e pages-e2e
```

`node:sqlite` runs fine under Jest (see `apps/api/test/sqlite.spec.ts`), so `better-sqlite3` is not needed.

## On the shop PC

- `start-shop.bat` (repo root) runs `tools/run-shop.cmd`, which starts `node <repo>\shop-web\apps\api\dist\main.js` from the repo root with `UV_THREADPOOL_SIZE=8`. When it exits it logs a line in `shop.log` and starts it again after a back-off (5 s, doubling after each run under a minute, up to 5 min; back to 5 s after a longer run); exit code 3 (the port is taken) is retried twice, 10 s apart, then stops the loop. `start-shop.bat` first waits up to ~10 s for nothing to listen on 8081. The server exits 1 after an uncaught exception (R13) and writes `started <host:port>` in `shop.log` at each start. `start-shop.bat python` starts `shop.py` instead (the rollback); the daily copy uses SQLite's backup (`.tmp`, then renamed).
- `node tools/switch-check.mjs` builds the api and the admin app, runs `nx run-many -t test`, the parity guard and every `tests/test_*.py`, then starts the built `main.js` on a throwaway root and a spare port (never 8081) and checks `GET /`, the contract, one-server-per-port against both servers (exit 3), the walk-up to `shop.py`, and that the bundle serves the built admin app at `/app/assets/`. It prints `ready` only when everything passes.

## The admin app

`apps/admin-app` is a React 19 app built with Vite into `apps/admin-app/dist` (git-ignored; `npx nx build admin-app`). The server serves its `index.html` at `/bills` and `/jobs` to a signed-in admin (anyone else gets a 303 to `/admin`; a "Not built yet" page until it is built) and its files at `/app/assets/` (nothing outside that folder, no folder listings, cached for a year since every name carries its hash). It talks to the API through `@shop/api-client` (Orval's TanStack Query hooks); the filters, the page and the open bill live in the URL query. `npx nx test admin-app` runs its Vitest tests (jsdom, Testing Library, a mocked `fetch`). It loads nothing from the internet: system fonts, no CDN.

## Import InvoMax

`node shop-web/apps/api/dist/main.js import-invomax` copies InvoMax's `INVOICE.btv` and `DETAIL.btv` (read-only; InvoMax's folder is never written) into `invomax-import/`, decodes them and upserts into `invomax.db` (WAL; TS-only). A torn copy is retried 3 times, a minute apart. The command prints the counts; `shop.log` gets counts only. InvoMax's folder is `C:\hunni\files`, or `invomaxDir` in `shop-settings.json` (repo root, git-ignored), or the `INVOMAX_DIR` environment variable.

## Backups

`backup.ts` makes `backups/tickets-YYYY-MM-DD.db` (and `invomax-YYYY-MM-DD.db` when `invomax.db` exists) with SQLite's online backup (`.tmp`, `quick_check`, then renamed); the nightly schedule is wired separately. Retention: the newest 90 tickets files; for InvoMax the newest 14 daily plus the first file of each of the newest 24 months. Only files named exactly like that are ever deleted.

- `node shop-web/apps/api/dist/main.js copy-backups E:` copies the backups to `E:\shop-backups` (only a drive letter like `E:` is accepted, never the backups' own drive; files already there with the same size and time are skipped, each new copy is flushed and checked) and records it in `backups/offsite.json` once every file is there. A missing drive is refused.
- `node shop-web/apps/api/dist/main.js restore backups/tickets-2026-11-20.db` (or an `invomax-` file) replaces `tickets.db` / `invomax.db` after checking the backup. Stop the shop server first: close the "Shop server" (run-shop) window, not just node, or run-shop restarts it after 5 s. It refuses unless nothing is listening on the port, checks that the backup holds the right tables, and puts the old files back if the swap fails part-way. An invomax restore also refuses while an import is running. The old file and its `-wal`/`-shm` are kept as `<name>.before-restore-YYYYMMDD-HHMMSS`.
- `start-shop.bat`'s daily `tickets-backup-*.db` copy stays as the safety net for the rollback path (`start-shop.bat python`); the two do not interfere.

## Parity guard

While both servers exist, `tools/parity-guard.mjs` keeps them in step. `PARITY` lists the git blob hash of `shop.py`, `tickets.py`, `accounts.py` and `pinweb.py`. CI runs `node tools/parity-guard.mjs` and fails if any of them differs. When it does, port the Python change to `shop-web`, then run `node tools/parity-guard.mjs --update` and commit the new `PARITY`.
