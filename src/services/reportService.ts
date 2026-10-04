import type { Db } from "../db/connection";
import type { MilestoneStatus } from "./couponService";
import type { CouponService } from "./couponService";

export interface ReportView {
  generatedAt: string;
  currency: string;
  orders: {
    totalPlaced: number;
  };
  revenue: {
    /** Sum of order subtotals (before discounts). */
    grossCents: number;
    /** Sum of discounts granted. */
    discountsCents: number;
    /** Sum of order totals; always grossCents - discountsCents. */
    netCents: number;
  };
  purchasedQuantityByProduct: Array<{
    productId: string;
    /** Current catalogue name (falls back to the snapshot if the product were ever removed). */
    productName: string;
    quantity: number;
    revenueCents: number;
  }>;
  coupons: {
    generated: number;
    available: number;
    redeemed: number;
  };
  milestones: MilestoneStatus;
}

/**
 * Read-only aggregation over orders, order_items and coupons. Executed inside a
 * single read transaction so all figures come from the same snapshot and
 * reconcile with each other (e.g. gross - discounts == net always holds).
 */
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly coupons: CouponService,
    private readonly currency: string,
  ) {}

  summary(): ReportView {
    return this.db.transaction((): ReportView => {
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS totalPlaced,
                  COALESCE(SUM(subtotal_minor), 0) AS grossCents,
                  COALESCE(SUM(discount_minor), 0) AS discountsCents,
                  COALESCE(SUM(total_minor), 0) AS netCents
           FROM orders`,
        )
        .get() as { totalPlaced: number; grossCents: number; discountsCents: number; netCents: number };

      const byProduct = this.db
        .prepare(
          `SELECT oi.product_id AS productId,
                  COALESCE(p.name, MAX(oi.product_name)) AS productName,
                  SUM(oi.quantity) AS quantity,
                  SUM(oi.line_total_minor) AS revenueCents
           FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
           GROUP BY oi.product_id
           ORDER BY quantity DESC, productId`,
        )
        .all() as ReportView["purchasedQuantityByProduct"];

      const couponCounts = this.db
        .prepare(
          `SELECT COUNT(*) AS generated,
                  COALESCE(SUM(status = 'AVAILABLE'), 0) AS available,
                  COALESCE(SUM(status = 'REDEEMED'), 0) AS redeemed
           FROM coupons`,
        )
        .get() as { generated: number; available: number; redeemed: number };

      return {
        generatedAt: new Date().toISOString(),
        currency: this.currency,
        orders: { totalPlaced: totals.totalPlaced },
        revenue: {
          grossCents: totals.grossCents,
          discountsCents: totals.discountsCents,
          netCents: totals.netCents,
        },
        purchasedQuantityByProduct: byProduct,
        coupons: couponCounts,
        milestones: this.coupons.milestoneStatus(),
      };
    })();
  }
}
