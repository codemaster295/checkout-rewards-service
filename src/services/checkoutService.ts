import { randomUUID } from "node:crypto";
import type { Db } from "../db/connection";
import { nowIso } from "../db/connection";
import { Errors, type InventoryShortfall } from "../domain/errors";
import { lineTotal, percentDiscount, sum } from "../domain/money";
import type { CartService } from "./cartService";
import { normaliseCouponCode } from "./couponService";
import { OrderService, type OrderView } from "./orderService";

export interface CheckoutRequest {
  cartId: string;
  couponCode?: string | null;
}

export interface CheckoutResult {
  order: OrderView;
  /**
   * true when this call did not place a new order but returned the one that an
   * earlier, equivalent request already placed (idempotent replay).
   */
  replayed: boolean;
}

/**
 * Checkout.
 *
 * The whole operation runs inside ONE `BEGIN IMMEDIATE` transaction, so it is
 * atomic: either all of {inventory decremented, coupon redeemed, order written,
 * cart closed} happen, or none do. A failure at any step (empty cart, stock
 * shortfall, invalid or already-used coupon) rolls everything back, which is
 * what guarantees "a coupon must not be consumed by a checkout that fails".
 *
 * Every state transition is written as a *conditional* UPDATE whose WHERE
 * clause re-states the precondition (inventory >= qty, status = 'AVAILABLE',
 * status = 'ACTIVE') and the code checks `changes === 1`. Under SQLite in a
 * single process this is belt-and-braces (BEGIN IMMEDIATE already serialises
 * writers), but it is exactly the shape that stays correct on PostgreSQL under
 * READ COMMITTED with many application instances, so nothing here needs to be
 * redesigned to scale out.
 *
 * Idempotency: the cart is the idempotency key. A cart can be checked out once;
 * re-sending the same checkout returns the existing order with `replayed=true`
 * (HTTP 200 instead of 201). A retry that differs materially (different coupon)
 * is rejected with 409 so the client learns an order already exists rather than
 * silently getting an order with different terms than it asked for.
 */
export class CheckoutService {
  private readonly orders: OrderService;

  constructor(
    private readonly db: Db,
    private readonly carts: CartService,
    private readonly currency: string,
  ) {
    this.orders = new OrderService(db);
  }

  checkout(request: CheckoutRequest): CheckoutResult {
    const requestedCoupon = request.couponCode ? normaliseCouponCode(request.couponCode) : null;

    const tx = this.db.transaction((): CheckoutResult => {
      // 1. Cart must exist. If it is already closed, this is a retry.
      const cart = this.carts.loadCart(request.cartId);
      if (cart.status === "CHECKED_OUT") {
        return this.replay(cart.id, cart.order_id, requestedCoupon);
      }

      // 2. Cart must have content.
      const lines = this.carts.loadLines(cart.id);
      if (lines.length === 0) throw Errors.cartEmpty(cart.id);

      // 3. Coupon, if supplied, must exist. (Redemption happens in step 6, after
      //    we know the order can actually be fulfilled.)
      const coupon = requestedCoupon ? this.loadCoupon(requestedCoupon) : null;

      // 4. Reserve inventory with a guarded decrement per line. We attempt every
      //    line so the client receives the complete list of shortfalls, then
      //    roll back if any failed.
      const decrement = this.db.prepare(
        `UPDATE products SET inventory = inventory - @qty, updated_at = @now
         WHERE id = @id AND inventory >= @qty`,
      );
      const now = nowIso();
      const shortfalls: InventoryShortfall[] = [];
      for (const line of lines) {
        const result = decrement.run({ id: line.product_id, qty: line.quantity, now });
        if (result.changes !== 1) {
          const current = this.db
            .prepare(`SELECT inventory FROM products WHERE id = ?`)
            .get(line.product_id) as { inventory: number };
          shortfalls.push({
            productId: line.product_id,
            productName: line.name,
            requested: line.quantity,
            available: current.inventory,
          });
        }
      }
      if (shortfalls.length > 0) throw Errors.insufficientInventory(shortfalls);

      // 5. Price the order from the *current* catalogue, snapshotting everything
      //    the order needs to explain itself later.
      const items = lines.map((l) => ({
        productId: l.product_id,
        productName: l.name,
        unitPriceCents: l.price_minor,
        quantity: l.quantity,
        lineTotalCents: lineTotal(l.price_minor, l.quantity),
      }));
      const subtotal = sum(items.map((i) => i.lineTotalCents));
      const orderId = randomUUID();

      // 6. Compute the discount (deterministic integer math, clamped >= 0).
      const discountPercent = coupon ? coupon.discount_percent : null;
      const discount = discountPercent === null ? 0 : percentDiscount(subtotal, discountPercent);
      const total = subtotal - discount; // >= 0 by construction of percentDiscount

      // 7. Write the order. It is assigned the next position in the order
      //    sequence; safe because the IMMEDIATE transaction holds the write lock,
      //    and the UNIQUE constraint on order_number rejects any violation anyway.
      //    The order row must exist before the coupon can reference it (FK).
      const { next } = this.db
        .prepare(`SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM orders`)
        .get() as { next: number };

      this.db
        .prepare(
          `INSERT INTO orders (id, order_number, cart_id, status, currency, subtotal_minor,
                               discount_minor, total_minor, coupon_code, discount_percent, created_at)
           VALUES (@id, @orderNumber, @cartId, 'PLACED', @currency, @subtotal, @discount, @total,
                   @couponCode, @discountPercent, @now)`,
        )
        .run({
          id: orderId,
          orderNumber: next,
          cartId: cart.id,
          currency: this.currency,
          subtotal,
          discount,
          total,
          couponCode: coupon?.code ?? null,
          discountPercent,
          now,
        });

      const insertItem = this.db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
         VALUES (@orderId, @productId, @productName, @unitPriceCents, @quantity, @lineTotalCents)`,
      );
      for (const item of items) insertItem.run({ orderId, ...item });

      // 8. Redeem the coupon with a compare-and-set. If another checkout won the
      //    race between step 3 and now, changes === 0 and we abort, rolling back
      //    the order and inventory writes above.
      if (coupon) {
        const redeemed = this.db
          .prepare(
            `UPDATE coupons SET status = 'REDEEMED', redeemed_by_order_id = ?, redeemed_at = ?
             WHERE code = ? AND status = 'AVAILABLE'`,
          )
          .run(orderId, now, coupon.code);
        if (redeemed.changes !== 1) throw Errors.couponAlreadyRedeemed(coupon.code);
      }

      // 9. Close the cart with a compare-and-set on its status.
      const closed = this.db
        .prepare(
          `UPDATE carts SET status = 'CHECKED_OUT', order_id = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'`,
        )
        .run(orderId, now, cart.id);
      if (closed.changes !== 1) {
        // Unreachable under SQLite serialisation; kept for portability.
        throw Errors.cartAlreadyCheckedOut(cart.id, null);
      }

      return { order: this.orders.get(orderId), replayed: false };
    });

    return tx.immediate();
  }

  private replay(cartId: string, orderId: string | null, requestedCoupon: string | null): CheckoutResult {
    if (!orderId) throw Errors.cartAlreadyCheckedOut(cartId, null);
    const order = this.orders.get(orderId);
    const originalCoupon = order.discount?.couponCode ?? null;
    if (originalCoupon !== requestedCoupon) {
      throw Errors.cartAlreadyCheckedOut(cartId, orderId);
    }
    return { order, replayed: true };
  }

  private loadCoupon(code: string): { code: string; discount_percent: number; status: string } {
    const row = this.db
      .prepare(`SELECT code, discount_percent, status FROM coupons WHERE code = ?`)
      .get(code) as { code: string; discount_percent: number; status: string } | undefined;
    if (!row) throw Errors.couponInvalid(code);
    // Fail fast with the specific error; the CAS in step 6 is the real guard.
    if (row.status !== "AVAILABLE") throw Errors.couponAlreadyRedeemed(code);
    return row;
  }
}
