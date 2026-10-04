import type Database from "better-sqlite3";

/**
 * Schema. Applied idempotently on startup (CREATE ... IF NOT EXISTS).
 *
 * Invariants enforced *by the database* (defence in depth behind the service
 * layer):
 *   - products.inventory >= 0            -> can never go negative even if a
 *                                           service bug skipped the conditional
 *                                           UPDATE guard.
 *   - orders.cart_id UNIQUE              -> a cart can produce at most one order.
 *   - orders.order_number UNIQUE         -> two orders can never claim the same
 *                                           position in the milestone sequence.
 *   - coupons.milestone_number UNIQUE    -> at most one coupon per milestone.
 *   - coupons.redeemed_by_order_id UNIQUE-> an order can redeem at most one coupon,
 *                                           and the pairing is one-to-one.
 *   - cart_items PK (cart_id, product_id)-> one line per product per cart.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  price_minor   INTEGER NOT NULL CHECK (price_minor >= 0),
  inventory     INTEGER NOT NULL CHECK (inventory >= 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CHECKED_OUT')),
  order_id      TEXT NULL REFERENCES orders(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id       TEXT NOT NULL REFERENCES carts(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  order_number     INTEGER NOT NULL UNIQUE,
  cart_id          TEXT NOT NULL UNIQUE REFERENCES carts(id),
  status           TEXT NOT NULL CHECK (status IN ('PLACED')),
  currency         TEXT NOT NULL,
  subtotal_minor   INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor   INTEGER NOT NULL CHECK (discount_minor >= 0 AND discount_minor <= subtotal_minor),
  total_minor      INTEGER NOT NULL CHECK (total_minor >= 0),
  coupon_code      TEXT NULL,
  discount_percent INTEGER NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id          TEXT NOT NULL REFERENCES orders(id),
  product_id        TEXT NOT NULL REFERENCES products(id),
  product_name      TEXT NOT NULL,
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  line_total_minor  INTEGER NOT NULL CHECK (line_total_minor >= 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code                  TEXT PRIMARY KEY,
  milestone_number      INTEGER NOT NULL UNIQUE,
  milestone_order_number INTEGER NOT NULL,
  discount_percent      INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  status                TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'REDEEMED')),
  redeemed_by_order_id  TEXT NULL UNIQUE REFERENCES orders(id),
  created_at            TEXT NOT NULL,
  redeemed_at           TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
