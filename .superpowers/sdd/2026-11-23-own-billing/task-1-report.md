# Task 1 report
Implemented shop-web/libs/domain/src/bill.ts (billAmounts, billRows, types), exported from index.ts; rules.ts now exports dec and mulCents (no behavior change). Rounding is bigint half-up: (x*5n+50n)/100n for supplies (capped 2000n), (x*6n+50n)/100n for tax.
Tests: bill.spec.ts, 8 tests (4 checked bills, deposit/balance, empty, rows). Uses jest (not vitest) and testing.ts helpers.
TDD: RED `NX_DAEMON=false npx nx test domain` -> bill.spec.ts "Test suite failed to run" (cannot map ./bill.js). GREEN same command -> Tests: 52 passed, 52 total.
Full: `NX_DAEMON=false npx nx run-many -t test lint typecheck -p domain` green.
Files: bill.ts, bill.spec.ts, index.ts, rules.ts.
Self-review: billAmounts converts totals()'s dollar floats back to cents via dec(toFixed(2)); safe since totals() derives them from exact cents. Concern: none.
