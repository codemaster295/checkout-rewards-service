import type { Db } from "../db/connection";
import { Errors } from "../domain/errors";

export interface OrderRow {
  id: string;
  order_number: number;
  cart_id: string;
  status: "PLACED";
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  total_minor: number;
  coupon_code: string | null;
  discount_percent: number | null;
  created_at: string;
}

export interface OrderItemRow {
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price_minor: number;
  quantity: number;
  line_total_minor: number;
}

export interface OrderItemView {
  productId: string;
  /** Snapshot at purchase time; immune to later catalogue edits. */
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderView {
  id: string;
  /** 1-based position in the sequence of successfully placed orders. */
  orderNumber: number;
  cartId: string;
  status: "PLACED";
  currency: string;
  items: OrderItemView[];
  subtotalCents: number;
  discount: { couponCode: string; percent: number; amountCents: number } | null;
  discountCents: number;
  totalCents: number;
  createdAt: string;
}

export class OrderService {
  constructor(private readonly db: Db) {}

  get(orderId: string): OrderView {
    const row = this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as OrderRow | undefined;
    if (!row) throw Errors.orderNotFound(orderId);
    return this.toView(row, this.loadItems(orderId));
  }

  list(): OrderView[] {
    const rows = this.db.prepare(`SELECT * FROM orders ORDER BY order_number`).all() as OrderRow[];
    return rows.map((r) => this.toView(r, this.loadItems(r.id)));
  }

  private loadItems(orderId: string): OrderItemRow[] {
    return this.db
      .prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id`)
      .all(orderId) as OrderItemRow[];
  }

  private toView(row: OrderRow, items: OrderItemRow[]): OrderView {
    return {
      id: row.id,
      orderNumber: row.order_number,
      cartId: row.cart_id,
      status: row.status,
      currency: row.currency,
      items: items.map((i) => ({
        productId: i.product_id,
        productName: i.product_name,
        unitPriceCents: i.unit_price_minor,
        quantity: i.quantity,
        lineTotalCents: i.line_total_minor,
      })),
      subtotalCents: row.subtotal_minor,
      discount:
        row.coupon_code !== null && row.discount_percent !== null
          ? { couponCode: row.coupon_code, percent: row.discount_percent, amountCents: row.discount_minor }
          : null,
      discountCents: row.discount_minor,
      totalCents: row.total_minor,
      createdAt: row.created_at,
    };
  }
}
