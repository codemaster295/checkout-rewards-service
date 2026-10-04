import type { Db } from "../db/connection";
import { nowIso } from "../db/connection";
import { Errors } from "../domain/errors";

export interface ProductRow {
  id: string;
  name: string;
  price_minor: number;
  inventory: number;
  created_at: string;
  updated_at: string;
}

export interface ProductView {
  id: string;
  name: string;
  unitPriceCents: number;
  availableInventory: number;
  createdAt: string;
  updatedAt: string;
}

export function toProductView(row: ProductRow): ProductView {
  return {
    id: row.id,
    name: row.name,
    unitPriceCents: row.price_minor,
    availableInventory: row.inventory,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProductService {
  constructor(private readonly db: Db) {}

  list(): ProductView[] {
    const rows = this.db.prepare(`SELECT * FROM products ORDER BY name`).all() as ProductRow[];
    return rows.map(toProductView);
  }

  get(productId: string): ProductView {
    const row = this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as
      | ProductRow
      | undefined;
    if (!row) throw Errors.productNotFound(productId, 404);
    return toProductView(row);
  }

  /**
   * Administrative: change price and/or absolute inventory. Setting inventory
   * is an absolute "stock count" write (what a stock-take does), not a delta;
   * sales already committed are unaffected because orders snapshot their data.
   */
  update(productId: string, patch: { unitPriceCents?: number; inventory?: number }): ProductView {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as
        | ProductRow
        | undefined;
      if (!existing) throw Errors.productNotFound(productId, 404);
      this.db
        .prepare(
          `UPDATE products SET price_minor = @price, inventory = @inventory, updated_at = @now WHERE id = @id`,
        )
        .run({
          id: productId,
          price: patch.unitPriceCents ?? existing.price_minor,
          inventory: patch.inventory ?? existing.inventory,
          now: nowIso(),
        });
      return this.get(productId);
    });
    return tx.immediate();
  }
}
