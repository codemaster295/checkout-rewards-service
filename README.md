# Checkout and Rewards Service

Backend for an ecommerce store: carts, atomic and idempotent checkout, inventory protection, "every nth order" discount coupons, and admin reporting.

**Stack:** Node 20, TypeScript, Express 4, SQLite (`better-sqlite3`), Zod, Vitest.

See [`DECISIONS.md`](./DECISIONS.md) for invariants, semantics, trade-offs, and what was deferred. See [`openapi.yaml`](./openapi.yaml) for the full API contract.

Approximate time spent: ~5 hours.

## Run it

```bash
npm install
npm start            # http://localhost:3000, SQLite file at data/store.sqlite
```

The schema is created and the catalogue seeded automatically on first start (idempotently; restarts do not reset stock). No external services or credentials.

Other commands:

```bash
npm test             # full suite incl. concurrency tests (~20 s)
npm run typecheck
npm run dev          # watch mode
npm run demo         # executable API walkthrough against a running server
npm run build        # compile to dist/
```

Configuration (environment variables, all optional):

| Variable                  | Default             | Meaning                                            |
| ------------------------- | ------------------- | -------------------------------------------------- |
| `PORT`                    | `3000`              | HTTP port                                          |
| `DB_PATH`                 | `data/store.sqlite` | SQLite file; use `:memory:` for an ephemeral store |
| `COUPON_EVERY_N_ORDERS`   | `5`                 | `n` — every nth order unlocks a coupon             |
| `COUPON_DISCOUNT_PERCENT` | `10`                | `x` — percent off, integer 1–100                   |
| `CURRENCY`                | `USD`               | Label only; all amounts are integer minor units    |

Quick demo with a short milestone:

```bash
COUPON_EVERY_N_ORDERS=2 DB_PATH=:memory: npm start
# in another terminal
npm run demo
```

(PowerShell: `$env:COUPON_EVERY_N_ORDERS="2"; $env:DB_PATH=":memory:"; npm start`)

## Seed catalogue

| id             | name                  | price (cents) | inventory |
| -------------- | --------------------- | ------------- | --------- |
| `prod-tshirt`  | Classic T-Shirt       | 1999          | 100       |
| `prod-hoodie`  | Zip Hoodie            | 5950          | 40        |
| `prod-mug`     | Ceramic Mug           | 1250          | 250       |
| `prod-sticker` | Sticker Pack          | 499           | 1000      |
| `prod-poster`  | Art Print Poster      | 2475          | 60        |
| `prod-limited` | Limited Edition Vinyl | 8999          | **3**     |

## API overview

All amounts are integers in minor units (`*Cents`). Every error has the shape `{ "error": { "code", "message", "details"? } }`; branch on `code`.

### Customer endpoints

| Method | Path                                | Success | Notes                                                                                         |
| ------ | ----------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| GET    | `/products`                         | 200     | Live prices and inventory                                                                     |
| GET    | `/products/:id`                     | 200     | 404 `PRODUCT_NOT_FOUND`                                                                       |
| POST   | `/carts`                            | 201     | Empty cart                                                                                    |
| GET    | `/carts/:cartId`                    | 200     | Live prices, line totals, subtotal, stock `warnings`                                          |
| POST   | `/carts/:cartId/items`              | 201     | `{productId, quantity}`; merges into an existing line. 400/404/409/422                        |
| PUT    | `/carts/:cartId/items/:productId`   | 200     | `{quantity}`; sets quantity of an existing line. 404 `CART_ITEM_NOT_FOUND` if absent          |
| DELETE | `/carts/:cartId/items/:productId`   | 200     | Remove line                                                                                   |
| POST   | `/carts/:cartId/checkout`           | **201** | `{couponCode?}`. Retry of an equivalent request → **200** + `Idempotent-Replayed: true`       |
| GET    | `/orders/:orderId`                  | 200     | Immutable snapshot                                                                            |

### Administrative endpoints (no auth implemented — see DECISIONS.md)

| Method | Path                        | Success | Notes                                                                        |
| ------ | --------------------------- | ------- | ---------------------------------------------------------------------------- |
| POST   | `/admin/coupons`            | 201     | Generate a coupon for the lowest unrewarded milestone; 409 `MILESTONE_NOT_REACHED` |
| GET    | `/admin/coupons`            | 200     | All coupons + milestone status                                               |
| GET    | `/admin/coupons/:code`      | 200     | 422 `COUPON_INVALID`                                                         |
| GET    | `/admin/orders`             | 200     | All orders (for reconciling with the report)                                 |
| GET    | `/admin/report`             | 200     | Quantities by product, gross/discount/net revenue, coupon counts, order count. Read-only |
| PATCH  | `/admin/products/:id`       | 200     | `{unitPriceCents?, inventory?}` — change the catalogue to observe cart/order behaviour |

### Error codes

| HTTP | code                       | When                                                                      |
| ---- | -------------------------- | ------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`         | Malformed body/params; `details.issues[]` lists each problem              |
| 404  | `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `CART_ITEM_NOT_FOUND`, `NOT_FOUND` | Resource in the URL does not exist |
| 409  | `INSUFFICIENT_INVENTORY`   | Requested quantity exceeds stock; `details.items[]` lists every short line |
| 409  | `CART_ALREADY_CHECKED_OUT` | Mutating a closed cart, or re-checking-out with different terms; `details.orderId` |
| 409  | `COUPON_ALREADY_REDEEMED`  | Coupon has been used (including: lost a race for it)                      |
| 409  | `MILESTONE_NOT_REACHED`    | Admin asked for a coupon but no unrewarded milestone exists; details say how far away |
| 422  | `CART_EMPTY`               | Checkout of an empty cart                                                 |
| 422  | `COUPON_INVALID`           | Unknown coupon code                                                       |
| 422  | `PRODUCT_NOT_FOUND`        | Product referenced in a request *body* does not exist                     |

### Example session

```bash
CART=$(curl -s -X POST localhost:3000/carts | jq -r .id)
curl -s -X POST localhost:3000/carts/$CART/items -H 'content-type: application/json' \
     -d '{"productId":"prod-tshirt","quantity":2}'
curl -s localhost:3000/carts/$CART
curl -s -i -X POST localhost:3000/carts/$CART/checkout -H 'content-type: application/json' -d '{}'   # 201
curl -s -i -X POST localhost:3000/carts/$CART/checkout -H 'content-type: application/json' -d '{}'   # 200, Idempotent-Replayed: true
curl -s -X POST localhost:3000/admin/coupons       # 409 until n orders exist, then 201
curl -s localhost:3000/admin/report
```

## Tests

```
tests/money.test.ts         rounding, clamping, overflow guards
tests/cart.test.ts          cart CRUD, validation, merge semantics, live price/stock changes
tests/checkout.test.ts      snapshot, idempotent replay, mismatched retry, atomic rollback
tests/coupons.test.ts       milestone eligibility, single generation, redemption, failed-checkout safety
tests/report.test.ts        reconciliation against /admin/orders and /admin/coupons; read-only
tests/concurrency.test.ts   overlapping HTTP requests: oversell race, same-cart race, coupon race, generation race
tests/multiprocess.test.ts  worker threads with independent SQLite connections on one file (real lock contention)
```

## Project layout

```
src/
  index.ts              server bootstrap
  app.ts                createApp() / buildServices() wiring
  config.ts             env configuration
  domain/errors.ts      AppError + error catalogue
  domain/money.ts       integer money arithmetic
  db/schema.ts          DDL with DB-level invariants
  db/connection.ts      SQLite open + pragmas
  db/seed.ts            catalogue seed (idempotent)
  services/             product, cart, checkout, order, coupon, report
  http/                 routes, zod validation, error handler
tests/
openapi.yaml
scripts/demo.mjs
DECISIONS.md
```
