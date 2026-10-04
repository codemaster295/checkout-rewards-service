import { randomUUID } from "node:crypto";
import type { Db } from "../db/connection";
import { nowIso } from "../db/connection";
import { Errors, type InventoryShortfall } from "../domain/errors";
import { lineTotal, sum } from "../domain/money";
import type { ProductRow } from "./productService";

export type CartStatus = "ACTIVE" | "CHECKED_OUT";

export interface CartRow {
  id: string;
  status: CartStatus;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A cart line joined with the *current* product record. */
export interface CartLineRow {
  cart_id: string;
  product_id: string;
  quantity: number;
  name: string;
  price_minor: number;
  inventory: number;
}

export interface CartItemView {
  productId: string;
  name: string;
  /** Current catalogue price; the cart does not lock prices. */
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  availableInventory: number;
  /** false when the requested quantity can no longer be fulfilled. */
  inStock: boolean;
}

export interface CartView {
  id: string;
  status: CartStatus;
  currency: string;
  items: CartItemView[];
  itemCount: number;
  subtotalCents: number;
  /** Non-fatal problems a client should surface before attempting checkout. */
  warnings: Array<{ code: "INSUFFICIENT_INVENTORY"; productId: string; requested: number; available: number }>;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MAX_LINE_QUANTITY = 999;

export class CartService {
  constructor(
    private readonly db: Db,
    private readonly currency: string,
  ) {}

  create(): CartView {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO carts (id, status, order_id, created_at, updated_at) VALUES (?, 'ACTIVE', NULL, ?, ?)`,
      )
      .run(id, now, now);
    return this.get(id);
  }

  get(cartId: string): CartView {
    // A single read transaction gives a consistent snapshot of cart + products.
    return this.db.transaction(() => {
      const cart = this.loadCart(cartId);
      const lines = this.loadLines(cartId);
      return this.toView(cart, lines);
    })();
  }

  /**
   * Add a product. If the product is already in the cart the quantities are
   * merged (classic "add to cart" semantics); use `setQuantity` to overwrite.
   */
  addItem(cartId: string, productId: string, quantity: number): CartView {
    return this.db.transaction(() => {
      const cart = this.loadActiveCart(cartId);
      const product = this.loadProduct(productId);
      const existing = this.db
        .prepare(`SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?`)
        .get(cartId, productId) as { quantity: number } | undefined;
      const newQuantity = (existing?.quantity ?? 0) + quantity;
      this.assertQuantityFulfillable(product, newQuantity);
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO cart_items (cart_id, product_id, quantity, added_at, updated_at)
           VALUES (@cartId, @productId, @quantity, @now, @now)
           ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = @quantity, updated_at = @now`,
        )
        .run({ cartId, productId, quantity: newQuantity, now });
      this.touch(cart.id, now);
      return this.toView({ ...cart, updated_at: now }, this.loadLines(cartId));
    }).immediate();
  }

  setQuantity(cartId: string, productId: string, quantity: number): CartView {
    return this.db.transaction(() => {
      const cart = this.loadActiveCart(cartId);
      const product = this.loadProduct(productId);
      this.assertQuantityFulfillable(product, quantity);
      const now = nowIso();
      const result = this.db
        .prepare(
          `UPDATE cart_items SET quantity = ?, updated_at = ? WHERE cart_id = ? AND product_id = ?`,
        )
        .run(quantity, now, cartId, productId);
      if (result.changes === 0) throw Errors.cartItemNotFound(cartId, productId);
      this.touch(cart.id, now);
      return this.toView({ ...cart, updated_at: now }, this.loadLines(cartId));
    }).immediate();
  }

  removeItem(cartId: string, productId: string): CartView {
    return this.db.transaction(() => {
      const cart = this.loadActiveCart(cartId);
      const result = this.db
        .prepare(`DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?`)
        .run(cartId, productId);
      if (result.changes === 0) throw Errors.cartItemNotFound(cartId, productId);
      const now = nowIso();
      this.touch(cart.id, now);
      return this.toView({ ...cart, updated_at: now }, this.loadLines(cartId));
    }).immediate();
  }

  // ---- helpers shared with CheckoutService -------------------------------

  loadCart(cartId: string): CartRow {
    const cart = this.db.prepare(`SELECT * FROM carts WHERE id = ?`).get(cartId) as CartRow | undefined;
    if (!cart) throw Errors.cartNotFound(cartId);
    return cart;
  }

  loadActiveCart(cartId: string): CartRow {
    const cart = this.loadCart(cartId);
    if (cart.status !== "ACTIVE") throw Errors.cartAlreadyCheckedOut(cartId, cart.order_id);
    return cart;
  }

  loadLines(cartId: string): CartLineRow[] {
    return this.db
      .prepare(
        `SELECT ci.cart_id, ci.product_id, ci.quantity, p.name, p.price_minor, p.inventory
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
         WHERE ci.cart_id = ?
         ORDER BY ci.added_at, ci.product_id`,
      )
      .all(cartId) as CartLineRow[];
  }

  toView(cart: CartRow, lines: CartLineRow[]): CartView {
    const items = lines.map<CartItemView>((l) => ({
      productId: l.product_id,
      name: l.name,
      unitPriceCents: l.price_minor,
      quantity: l.quantity,
      lineTotalCents: lineTotal(l.price_minor, l.quantity),
      availableInventory: l.inventory,
      inStock: l.inventory >= l.quantity,
    }));
    const warnings: CartView["warnings"] = items
      .filter((i) => !i.inStock)
      .map((i) => ({
        code: "INSUFFICIENT_INVENTORY" as const,
        productId: i.productId,
        requested: i.quantity,
        available: i.availableInventory,
      }));
    return {
      id: cart.id,
      status: cart.status,
      currency: this.currency,
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: sum(items.map((i) => i.lineTotalCents)),
      warnings,
      orderId: cart.order_id,
      createdAt: cart.created_at,
      updatedAt: cart.updated_at,
    };
  }

  private loadProduct(productId: string): ProductRow {
    const product = this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as
      | ProductRow
      | undefined;
    // Referenced from the request body, not the URL -> 422 rather than 404.
    if (!product) throw Errors.productNotFound(productId, 422);
    return product;
  }

  /**
   * Early feedback only. Carts do not reserve stock, so passing this check is
   * not a promise; checkout re-validates atomically against live inventory.
   */
  private assertQuantityFulfillable(product: ProductRow, quantity: number): void {
    if (quantity > MAX_LINE_QUANTITY) {
      throw Errors.validation(`Quantity per line cannot exceed ${MAX_LINE_QUANTITY}`, {
        productId: product.id,
        requested: quantity,
        max: MAX_LINE_QUANTITY,
      });
    }
    if (product.inventory < quantity) {
      const shortfall: InventoryShortfall = {
        productId: product.id,
        productName: product.name,
        requested: quantity,
        available: product.inventory,
      };
      throw Errors.insufficientInventory([shortfall]);
    }
  }

  private touch(cartId: string, now: string): void {
    this.db.prepare(`UPDATE carts SET updated_at = ? WHERE id = ?`).run(now, cartId);
  }
}
