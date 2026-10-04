# DECISIONS

Approximate time spent: ~5 hours.

## 1. System invariants

Each invariant lists where it is enforced. "Service" means application code; "DB" means a constraint that holds even if the service has a bug.

| #   | Invariant                                                                                                  | Enforced in                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | Inventory never goes negative; the sum of units sold for a product never exceeds its starting stock.       | Service: `UPDATE products SET inventory = inventory - q WHERE id = ? AND inventory >= q`, `changes === 1` checked. DB: `CHECK (inventory >= 0)`.         |
| I2  | A cart produces at most one order; a checked-out cart cannot be modified.                                  | Service: cart status read + CAS `WHERE status = 'ACTIVE'`. DB: `orders.cart_id UNIQUE`.                                                                 |
| I3  | A retried checkout never creates a second order or decrements inventory twice.                             | Service: status `CHECKED_OUT` short-circuits to the existing order *before* any write. Follows from I2.                                                 |
| I4  | A coupon is redeemed at most once, by exactly one order.                                                   | Service: CAS `UPDATE coupons ... WHERE code = ? AND status = 'AVAILABLE'`. DB: `redeemed_by_order_id UNIQUE`.                                           |
| I5  | A failed checkout leaves inventory, coupon, cart and order tables exactly as they were.                    | Single `BEGIN IMMEDIATE` transaction around the whole checkout; any thrown error rolls back.                                                            |
| I6  | At most one coupon per milestone; a coupon only exists for a milestone that has been reached.              | Service: `milestonesReached - couponsGenerated > 0` check inside an IMMEDIATE tx. DB: `coupons.milestone_number UNIQUE`.                                |
| I7  | Order numbers are dense, unique and monotonic (1, 2, 3, …), so "every nth order" is well defined.         | Service: `MAX(order_number) + 1` under the write lock. DB: `order_number UNIQUE`.                                                                       |
| I8  | An order is self-describing: it stores product name, unit price, quantity, line total, subtotal, discount, total and coupon code at purchase time. | Service: `order_items` snapshot columns; `GET /orders/:id` never joins to `products` for prices.                        |
| I9  | `total = subtotal - discount`, `0 <= discount <= subtotal`, `total >= 0`.                                   | Service: `percentDiscount` clamps. DB: `CHECK (discount_minor <= subtotal_minor)`, `CHECK (total_minor >= 0)`.                                           |
| I10 | The report reconciles with the orders and coupons the API returns, and never mutates state.                | Service: report is pure `SELECT` aggregation over the same tables inside one read transaction. Tested in `report.test.ts`.                              |
| I11 | Invalid products/quantities never enter a cart.                                                            | Service: strict Zod schemas (400), product existence (422), inventory check (409). DB: `CHECK (quantity > 0)`, FK to `products`.                        |

## 2. Ambiguities and the semantics I chose

| Question                                                                      | Choice                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Price changes after an item is added but before checkout                      | Carts store only `(productId, quantity)`; prices are read live when viewing and at checkout. The order snapshots the price *at checkout*. No price lock. Rationale: locking would let customers hoard a price in an abandoned cart; and showing a stale price then charging a new one is worse than being honest at every read. |
| Availability changes after add                                                | Cart view shows `availableInventory`, `inStock` and `warnings[]`. Checkout fails with 409 `INSUFFICIENT_INVENTORY` listing *every* short line and leaves the cart ACTIVE and unmodified, so the customer can adjust. The service does not silently cap quantities.                                                      |
| Adding a product already in the cart                                          | `POST /items` merges quantities (classic "add to cart"); `PUT /items/:productId` sets an absolute quantity and requires the line to exist (404 otherwise). The merged quantity must be fulfillable.                                                                                                                       |
| Quantity 0                                                                    | Rejected (400). Deletion is explicit via `DELETE`. Max 999 per line to bound arithmetic and abuse.                                                                                                                                                                                                                       |
| Adding more than available stock to a cart                                    | Rejected early with 409, but *not* a reservation. Checkout is the only place stock is committed.                                                                                                                                                                                                                         |
| Which orders count toward milestones                                          | Every successfully placed order, including ones that redeemed a coupon. Milestone *k* is reached when `k × n` orders exist (`orderNumber` = `k × n`).                                                                                                                                                                      |
| When coupons are created                                                      | Only when an admin asks (`POST /admin/coupons`), as specified. Checkout does not auto-generate. One coupon per call, lowest unrewarded milestone first; the response reports `unrewardedMilestones` so the admin can call again. Milestones never expire.                                                                 |
| Who may use a coupon                                                          | Anyone who presents the code (there is no authentication, so coupons cannot be customer-bound). Single use, globally.                                                                                                                                                                                                    |
| What a coupon applies to                                                      | `x%` of the whole order subtotal, rounded half-up to a minor unit, clamped to the subtotal. No minimum order, no expiry, one coupon per order.                                                                                                                                                                             |
| Coupon code matching                                                          | Case-insensitive, whitespace-trimmed. Codes look like `SAVE10-M1-7F2A9C` (percent, milestone, random suffix).                                                                                                                                                                                                             |
| Retrying checkout with a different coupon than the original                   | 409 `CART_ALREADY_CHECKED_OUT` with the existing `orderId`. It is not an idempotent replay because the client asked for different terms; silently returning the old order would hide that its coupon was not applied.                                                                                                      |
| Checkout of an empty cart                                                     | 422 `CART_EMPTY`; cart stays open.                                                                                                                                                                                                                                                                                       |
| Payment                                                                       | A committed checkout *is* payment success (see Decision 5).                                                                                                                                                                                                                                                              |
| Unknown entity referenced in a body vs. in the URL                            | URL → 404; body → 422 (`PRODUCT_NOT_FOUND` on add-to-cart, `COUPON_INVALID`). A 404 for a body field would be ambiguous with "the cart doesn't exist".                                                                                                                                                                      |

## 3. Material design decisions

### Decision 1: SQLite via `better-sqlite3` with synchronous, single-writer transactions

**Context:** The requirement is to preserve invariants when requests overlap, with a stack that anyone can run with `npm install && npm start`.

**Options considered:**
1. Pure in-memory Maps with hand-rolled mutexes.
2. PostgreSQL via Docker.
3. Embedded SQLite (`better-sqlite3`), file-backed, WAL mode.

**Choice:** SQLite with `better-sqlite3`.

**Why:** Option 1 forces me to re-implement atomicity and rollback myself, and the "mutex" only exists in one process, so it demonstrates nothing about how the design survives scale-out. Option 2 is the most production-like but adds a Docker dependency and setup risk for the evaluator. SQLite gives real ACID transactions, real constraints, and real cross-connection locking (I test this with worker threads), with zero setup. `better-sqlite3` is synchronous, which has a useful property: a transaction cannot yield to the event loop mid-way, so two HTTP requests can never interleave inside the critical section.

**Consequences:** Very simple reasoning about concurrency in one process. Writes are serialised (SQLite has one writer at a time), which is fine at this scale and is an honest reflection of what a checkout path needs anyway. Scale-out requires swapping the driver (see §7); the SQL shape was deliberately chosen so that is a mechanical change, not a redesign.

### Decision 2: Checkout as one `BEGIN IMMEDIATE` transaction with compare-and-set writes

**Context:** Checkout touches four tables (products, coupons, orders, carts) and must be all-or-nothing under concurrency.

**Options considered:**
1. Read everything, validate in memory, then write (check-then-act).
2. Pessimistic: take the write lock up front (`BEGIN IMMEDIATE`) and perform guarded `UPDATE ... WHERE <precondition>` statements, verifying `changes === 1`.
3. Optimistic: version columns on products/coupons; retry on conflict.

**Choice:** Option 2.

**Why:** Option 1 is the classic lost-update race and is only "safe" here by accident of Node being single-threaded; I did not want correctness to depend on that. Option 3 is good for high-contention catalogues but adds retry loops and more surface area for a 4–6 hour build. Option 2 is the smallest correct thing: `BEGIN IMMEDIATE` means we hold the write lock before reading, so what we read is what we write against; and the guarded UPDATEs mean that even on a database that *does* allow concurrent writers (PostgreSQL READ COMMITTED), each decrement/redeem/close is atomic and self-checking. Every write restates its precondition in its `WHERE` clause.

**Consequences:** The checkout code is linear and readable (nine numbered steps). Inventory decrements are attempted for every line before failing so the client gets the *complete* shortfall list, relying on rollback to undo the ones that succeeded. One subtlety this surfaced: the coupon CAS writes `redeemed_by_order_id`, which is a FK to `orders`, so the order row must be inserted *before* the coupon is redeemed (SQLite checks FKs immediately). The first version had the order the other way round and failed with a FK error in the smoke test; reordering kept atomicity because a failed CAS still rolls the order back.

### Decision 3: The cart is the idempotency key for checkout

**Context:** Clients retry after timeouts. A retry must not create another order or charge inventory twice.

**Options considered:**
1. Require an `Idempotency-Key` header and store key → response in a table.
2. Treat the cart as the natural idempotency key: it can be checked out once, and re-checkout returns the existing order.
3. Both.

**Choice:** Option 2, with request-equivalence checking.

**Why:** Checkout is not a generic "create" — the domain already has a unique, client-held handle (the cart) that is consumed by the operation. Making a cart single-use *is* the business rule ("a cart must not be checked out more than once"), so using it as the key means idempotency is not an add-on that clients might forget to send; it is structural. A retry returns 200 (not 201) plus `Idempotent-Replayed: true`, so clients and logs can tell replays from first placements. If the retry carries different terms (a different coupon) I return 409 with the existing `orderId` rather than pretending it matched; Stripe-style key reuse with a different payload is also an error, for the same reason.

**Consequences:** Simpler API and no key-storage table to expire. The limitation: the client cannot "try again with a different coupon" on the same cart; they would need a new cart — acceptable because the order already exists and nothing was lost. If I later needed idempotency for non-consuming operations (e.g. "create cart" itself), I would add option 1 for those.

### Decision 4: Integer minor units everywhere; half-up rounding; clamp

**Context:** "Calculate money without floating-point rounding errors."

**Options considered:**
1. `number` in major units (dollars) — rejected outright.
2. A decimal library (`decimal.js`, `big.js`).
3. Integer minor units (cents) as JS `number`, guarded with `Number.isSafeInteger`.
4. `BigInt`.

**Choice:** Option 3.

**Why:** All arithmetic in this domain is `price × qty`, sums, and one percentage. In integers that is exact. JS integers are exact to 2^53−1 (≈ $90 trillion in cents), far outside any plausible value, and `assertSafeMoney` throws if anything approaches it. A decimal library adds a dependency to solve a problem the domain does not have; `BigInt` does not serialise to JSON and complicates SQLite bindings. The discount is `floor((amount × pct + 50) / 100)` — round half-up, implemented in integer math (no `/100` of a float), and then `min(·, amount)` so a total can never go negative even at 100%.

**Consequences:** Every API field is an integer with a `Cents` suffix and the order carries `currency`. If multi-currency with different minor-unit exponents were added, the only change would be a per-currency exponent for display; the arithmetic is unchanged. The rounding rule is encoded once (`percentDiscount`) and unit-tested at the boundaries (…4/…5/…9 cents, 1 cent at 100%).

### Decision 5: No payment abstraction; a committed checkout is payment success

**Context:** The brief allows either treating checkout success as payment or introducing a fake gateway.

**Options considered:**
1. Fake `PaymentGateway.charge()` called *inside* the checkout transaction.
2. Full two-phase flow: `PENDING_PAYMENT` order → commit → charge → `PAID`/compensate.
3. No payment step; order is `PLACED` on commit.

**Choice:** Option 3.

**Why:** Option 1 is actively misleading: a real payment call is a network side effect that cannot be rolled back by the database, so putting it inside the transaction demonstrates the wrong pattern. Option 2 is the correct production design but doubles the state machine (orders can be pending or failed; the report must exclude them; inventory must be released on failure; milestones must only count paid orders) — more than the timebox allows and orthogonal to the invariants being evaluated. Option 3 keeps the order model honest: there is exactly one order status, and everything the report counts is final.

**Consequences:** Adding payment later means introducing `PENDING_PAYMENT` and a compensating "release" transaction, and changing `order_number` assignment to happen at `PAID` time (or accepting gaps). I kept `status` as a column with a CHECK constraint so that extension is additive.

### Decision 6: Carts store references, not price snapshots

**Context:** What should a cart show and charge if the catalogue changes while it is open?

**Options considered:**
1. Snapshot price into `cart_items` at add time and charge that.
2. Snapshot but re-validate at checkout and fail if changed.
3. Store only `(product_id, quantity)`; always read live.

**Choice:** Option 3.

**Why:** Option 1 creates a free "price lock" with no expiry, which is a business decision the brief does not grant, and lets abandoned carts hold stale prices indefinitely. Option 2 turns every repricing into a customer-facing error. Option 3 is the simplest model: the cart is a shopping list; the *order* is the contract and snapshots everything. The cart view is explicit about it (`unitPriceCents` is the live price; `warnings` flag stock problems).

**Consequences:** No stale data to reconcile. The trade-off is UX: a customer may see a price change between viewing the cart and the order confirmation. A "price changed since you last looked" notice would need the client to send the price it last saw; I noted this as a follow-up rather than building it.

### Decision 7: Admin generates one coupon per call, lowest milestone first

**Context:** "A coupon is generated only if the configured order milestone has been reached and a coupon has not already been generated for that milestone." The brief does not say what happens if several milestones are outstanding.

**Options considered:**
1. Generate every outstanding coupon in one call.
2. One per call, lowest first; response tells the admin how many remain.
3. Auto-generate at checkout when `orderNumber % n === 0`.

**Choice:** Option 2.

**Why:** Option 3 contradicts "an administrator can request coupon generation" and would couple the checkout transaction to coupon creation. Option 1 is reasonable but makes the response a list and the 201/409 distinction murkier. Option 2 keeps each call a single, auditable event (one coupon ↔ one milestone) and is trivially safe to retry: a repeat call either rewards the next milestone or returns 409 with full status. The `UNIQUE(milestone_number)` constraint makes double-generation impossible even if two admins race.

**Consequences:** If an admin falls far behind they must call repeatedly; the `unrewardedMilestones` counter tells them how many times. Tested with 10 concurrent generation calls (one 201, nine 409s) in-process and across worker threads.

## 4. Transaction, concurrency and idempotency strategy

**Transactions.** Every mutation is a `db.transaction(...).immediate()` — SQLite `BEGIN IMMEDIATE` — which acquires the write lock before the first read. Reads that must be self-consistent (cart view, report) run in a deferred read transaction so they see one snapshot.

**Concurrency within one process.** `better-sqlite3` is synchronous; a transaction runs from `BEGIN` to `COMMIT` without returning to the event loop. Two HTTP handlers therefore cannot interleave inside a critical section. `tests/concurrency.test.ts` fires 20 simultaneous checkouts at 3 units of stock and asserts exactly 3 orders and inventory 0; 15 simultaneous checkouts of one cart and asserts one 201 and fourteen replays; two carts racing for one coupon; ten racing coupon generations.

**Concurrency across connections.** This is the case that matters for scale-out, and I did not want to claim it worked without exercising it. `tests/multiprocess.test.ts` spawns worker threads that each open their *own* connection to a shared SQLite file and check out concurrently. Serialisation then depends on SQLite's file/WAL locks plus `busy_timeout = 5000` (writers wait rather than fail), and correctness depends on the conditional UPDATEs — not on the event loop. The same assertions hold: 40 carts across 4 workers → exactly 3 orders; 6 carts with one coupon across 3 workers → one redemption; 12 generation attempts across 4 workers for 3 milestones → exactly 3 coupons.

**Idempotency.** Checkout: cart is the key (Decision 3). Coupon generation: naturally idempotent in effect — a repeat either rewards the *next* milestone or 409s; it never duplicates. Report: pure read. Cart mutations are not idempotent in the strict sense (`POST /items` merges), which is standard for add-to-cart; `PUT` and `DELETE` are idempotent.

**Order of checks in checkout** (why it matters): the `CHECKED_OUT` check comes *first*, before coupon validation. Otherwise a retry of a successful coupon checkout would fail with `COUPON_ALREADY_REDEEMED` (the coupon *was* redeemed — by this very order). The test "retrying a successful coupon checkout replays instead of failing on the used coupon" pins this.

## 5. Money and rounding rules

- Unit: integer minor units (cents). Fields are suffixed `Cents`; orders carry `currency`.
- `lineTotal = unitPrice × quantity`; `subtotal = Σ lineTotal`. All exact.
- `discount = min(subtotal, floor((subtotal × percent + 50) / 100))` — half-up to the nearest cent, never above the subtotal.
- `total = subtotal − discount ≥ 0`.
- Guards: every intermediate is checked with `Number.isSafeInteger`; the DB has `CHECK` constraints on non-negativity and `discount ≤ subtotal`.
- Examples: 1999 @ 10% → 200; 1994 → 199; 1995 → 200; 5 → 1; 4 → 0; 5 @ 100% → 5 (total 0).

## 6. Error model

Uniform body `{ error: { code, message, details? } }`. `code` is a closed enum (`src/domain/errors.ts`), stable, and the thing clients branch on; `message` is for humans; `details` carries structured data (e.g. every short line with `requested`/`available`, or the `orderId` that already exists).

Status mapping is by *kind of failure*, not by entity:

- **400** the request is malformed (type/shape). Zod schemas are `strict()` — unknown fields are rejected, not ignored, because a typo'd `couponCod` silently dropping the coupon is worse than a 400.
- **404** the thing addressed by the URL does not exist.
- **409** the request is fine but conflicts with current state (stock, already checked out, coupon used, milestone not reached). These are the retry-after-adjusting cases.
- **422** the request is well formed but semantically unusable (empty cart, body refers to an unknown product/coupon).
- **500** only for genuinely unexpected errors; never for domain conditions.

Replay is signalled with 200 vs 201 *and* an `Idempotent-Replayed` header, so clients that only look at "2xx" still work and clients that care can tell.

## 7. Implemented vs. intentionally deferred

**Implemented:** everything in the brief's business requirements and API minimum, plus `GET /admin/orders` and `GET /admin/coupons` (so the report can be reconciled), `PATCH /admin/products/:id` (to demonstrate the price/stock-change semantics), an OpenAPI document, and an executable demo.

**Deferred, deliberately:**

| Item                                    | Why deferred / how I would do it                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication / authorisation          | Explicitly out of scope. `/admin/*` is the privileged surface; an auth middleware on that router is the insertion point.                                                                      |
| Payment                                 | Decision 5. Would add `PENDING_PAYMENT`/`FAILED` statuses and a compensating release transaction.                                                                                              |
| Cart expiry / cleanup                   | Carts never reserve stock, so abandoned carts cost nothing but rows. A TTL sweep is trivial to add.                                                                                            |
| Coupon expiry, customer binding, minimum spend | No auth → no customer identity. Would add `expires_at`, `customer_id`, `min_subtotal_minor` columns and checks in step 3 of checkout.                                                    |
| Pagination on admin lists               | Lists are small at this scale; would add cursor pagination before production.                                                                                                                 |
| Migrations tooling                      | Schema is applied with `CREATE IF NOT EXISTS`; fine for v1 of an embedded DB. Would move to numbered migrations (e.g. `node-pg-migrate`) with Postgres.                                         |
| Structured logging, metrics, request IDs | Would add `pino` + request-id middleware; not needed to evaluate correctness.                                                                                                                 |
| "Price changed since you saw it" detection | Would require the client to echo the last-seen `subtotalCents`/price; see Decision 6.                                                                                                      |
| Rate limiting on `/admin/coupons`       | Harmless to spam (409s), so low priority.                                                                                                                                                      |

## 8. Evolution for multiple instances and production scale

SQLite is a single-writer, single-host database; the moment there are two application instances on different hosts it has to go. The design was chosen so that the migration is mechanical:

1. **Swap the driver to PostgreSQL.** The SQL is standard. `BEGIN IMMEDIATE` becomes `BEGIN` plus `SELECT ... FOR UPDATE` on the cart row at the top of checkout (that gives the same "lock then read" shape and serialises concurrent checkouts *of the same cart*, which is what makes the replay path race-free). The guarded `UPDATE ... WHERE inventory >= q` / `WHERE status = 'AVAILABLE'` / `WHERE status = 'ACTIVE'` statements need no change: under READ COMMITTED each is atomic and re-evaluates its predicate on the current row version after waiting for a conflicting writer. `changes === 1` becomes `rowCount === 1`.
2. **Order numbering.** `MAX(order_number)+1` is only safe under a global write lock. In Postgres use a `SEQUENCE` (accepting gaps on rollback — milestones would then be computed from `COUNT(*)` rather than `order_number`, which the code already does for eligibility) or a single-row counter table locked `FOR UPDATE` if dense numbering is a hard requirement.
3. **Milestone generation.** `UNIQUE(milestone_number)` already makes the race safe; the service would catch the unique-violation and map it to 409 instead of relying on the lock to prevent it.
4. **Idempotency across instances** already works because the key (the cart) lives in the database, not in process memory.
5. **Hot products.** If one SKU sees thousands of checkouts per second, row-level contention on `products` becomes the bottleneck. Options in order of complexity: shorter transactions (already minimal), inventory sharding into buckets, or moving to a reservation ledger (append-only `inventory_movements`, with availability as a materialised sum). I would not do this preemptively.
6. **Reporting.** The report is an aggregation over all orders; at scale it moves to a read replica or an incrementally maintained summary table updated in the checkout transaction (which is why I kept per-order `subtotal/discount/total` columns rather than deriving them from items on read).
7. **Caching the catalogue** at the edge is safe because carts read live prices and checkout re-reads inside the transaction — a stale catalogue read can only ever produce a *more* conservative cart warning, never an incorrect order.

What would *not* change: the domain model, the error contract, the snapshot-on-order rule, the integer money rules, and the test assertions.

## 9. How I used AI tools

I used an AI coding assistant (Claude, in Cursor) throughout: to draft the initial module skeletons from my design, to write the first pass of tests from my list of scenarios, to generate the OpenAPI document from the route code, and as a sounding board for the semantics table in §2. I reviewed and ran every line; the concurrency tests in particular exist because I did not trust "this is safe because Node is single-threaded" without evidence.

Places where I corrected, rejected, or redirected its output:

- **Rejected an in-transaction fake payment gateway.** The assistant initially proposed a `PaymentGateway` interface with a `charge()` call inside the checkout transaction to "show where payment slots in". I rejected it: a network side effect inside a DB transaction demonstrates the wrong pattern (it cannot be rolled back), and a fake that always succeeds adds a seam with no behaviour. I chose to treat commit as payment and document the real two-phase design instead (Decision 5).
- **Caught and fixed a transaction-ordering bug.** The first generated checkout redeemed the coupon (writing `redeemed_by_order_id`) *before* inserting the order row. It type-checked and read correctly, but SQLite enforces foreign keys immediately, so the first coupon checkout in the smoke run returned a 500 (`FOREIGN KEY constraint failed`). I reordered the steps (order insert → coupon CAS → cart close) and confirmed atomicity is preserved because a failed CAS still rolls the order back. This is the clearest example of why I ran the service end-to-end rather than trusting a green typecheck.
- **Rewrote an over-clever config loader.** The first `loadConfig` temporarily reassigned `process.env` to make a helper testable. It worked but was a side-effecting trick in a module that should be trivially pure; I replaced it with a helper that takes `env` as a parameter.
- **Redirected the idempotency design.** The assistant's default was an `Idempotency-Key` header with a key→response table. I pushed back that the cart is already a single-use handle and that making the key optional would make the guarantee optional; we ended up with the cart-as-key design plus explicit request-equivalence checking (Decision 3).
- **Simplified a generated test.** A concurrency test computed the "loser cart" through a convoluted conditional on error details; I replaced it with a direct `winner.cartId === a ? b : a`.

## 10. What I would examine first with another two hours

1. **Finish mutation-testing the guards.** I did this for one: deleting `AND inventory >= @qty` makes two tests fail (the DB `CHECK (inventory >= 0)` turns the oversell into a 500, which the status assertions catch) — so the defence-in-depth layer is real. I would repeat it for `AND status = 'AVAILABLE'` on the coupon and for the `CHECKED_OUT` short-circuit. For the coupon CAS I expect the *single-process* tests to stay green (the fail-fast read in step 3 is sufficient when writers are serialised), which would show that only the worker-thread tests exercise that guard — useful to know.
2. **Postgres spike.** Stand up the schema on Postgres, replace `BEGIN IMMEDIATE` with `SELECT ... FOR UPDATE` on the cart, and run the multiprocess test against it with real processes rather than worker threads — to prove §8 point 1 is as mechanical as I claim.
3. **The report under concurrent writes.** The report runs in a read transaction, so it is internally consistent, but I would add a test that interleaves checkouts with report reads and asserts `gross − discounts = net` and `Σ quantities = Σ order items` on every read.
4. **Failure of the FK ordering under Postgres.** Postgres can defer FK checks; SQLite cannot. I would make the coupon FK `DEFERRABLE INITIALLY DEFERRED` in the Postgres schema so ordering within the transaction stops being load-bearing.
5. **Observability for the 409 paths.** A customer who repeatedly hits `INSUFFICIENT_INVENTORY` on a cart with a stale quantity is a UX problem the server can see; I would add a counter per error code.
