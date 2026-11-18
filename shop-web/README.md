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

## Parity guard

While both servers exist, `tools/parity-guard.mjs` keeps them in step. `PARITY` lists the git blob hash of `shop.py`, `tickets.py`, `accounts.py` and `pinweb.py`. CI runs `node tools/parity-guard.mjs` and fails if any of them differs. When it does, port the Python change to `shop-web`, then run `node tools/parity-guard.mjs --update` and commit the new `PARITY`.
