import type { Db } from "./connection";
import { nowIso } from "./connection";

export interface SeedProduct {
  id: string;
  name: string;
  priceMinor: number;
  inventory: number;
}

/**
 * Deterministic catalogue. Stable IDs make the API easy to exercise by hand.
 * `prod-limited` has deliberately scarce stock to exercise oversell protection.
 */
export const SEED_PRODUCTS: SeedProduct[] = [
  { id: "prod-tshirt", name: "Classic T-Shirt", priceMinor: 1999, inventory: 100 },
  { id: "prod-hoodie", name: "Zip Hoodie", priceMinor: 5950, inventory: 40 },
  { id: "prod-mug", name: "Ceramic Mug", priceMinor: 1250, inventory: 250 },
  { id: "prod-sticker", name: "Sticker Pack", priceMinor: 499, inventory: 1000 },
  { id: "prod-poster", name: "Art Print Poster", priceMinor: 2475, inventory: 60 },
  { id: "prod-limited", name: "Limited Edition Vinyl", priceMinor: 8999, inventory: 3 },
];

/**
 * Inserts seed products if they are absent. Idempotent: re-running never
 * resets inventory or prices of products that already exist, so restarting the
 * server does not undo real activity.
 */
export function seedProducts(db: Db, products: SeedProduct[] = SEED_PRODUCTS): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO products (id, name, price_minor, inventory, created_at, updated_at)
     VALUES (@id, @name, @priceMinor, @inventory, @now, @now)`,
  );
  const now = nowIso();
  let inserted = 0;
  db.transaction(() => {
    for (const p of products) {
      inserted += insert.run({ ...p, now }).changes;
    }
  })();
  return inserted;
}
