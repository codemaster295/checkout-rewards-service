import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection";
import { nowIso } from "../db/connection";
import { Errors } from "../domain/errors";

export type CouponStatus = "AVAILABLE" | "REDEEMED";

export interface CouponRow {
  code: string;
  milestone_number: number;
  milestone_order_number: number;
  discount_percent: number;
  status: CouponStatus;
  redeemed_by_order_id: string | null;
  created_at: string;
  redeemed_at: string | null;
}

export interface CouponView {
  code: string;
  /** k: this coupon rewards the k-th milestone. */
  milestoneNumber: number;
  /** The order_number (k * n) whose placement unlocked this coupon. */
  milestoneOrderNumber: number;
  discountPercent: number;
  status: CouponStatus;
  redeemedByOrderId: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface MilestoneStatus {
  everyNOrders: number;
  discountPercent: number;
  totalOrders: number;
  /** floor(totalOrders / n) */
  milestonesReached: number;
  couponsGenerated: number;
  /** milestonesReached - couponsGenerated */
  unrewardedMilestones: number;
  /** Orders still needed before another milestone is reached. */
  ordersUntilNextMilestone: number;
}

export interface GenerateResult {
  coupon: CouponView;
  milestones: MilestoneStatus;
}

export function normaliseCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

export function toCouponView(row: CouponRow): CouponView {
  return {
    code: row.code,
    milestoneNumber: row.milestone_number,
    milestoneOrderNumber: row.milestone_order_number,
    discountPercent: row.discount_percent,
    status: row.status,
    redeemedByOrderId: row.redeemed_by_order_id,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

/**
 * Coupon lifecycle.
 *
 * Semantics chosen (see DECISIONS.md):
 *  - Milestone k is reached once `k * n` orders have been placed.
 *  - Generation is admin-driven and creates ONE coupon per call for the lowest
 *    unrewarded milestone. Milestones never expire; if the admin falls behind,
 *    repeated calls catch up one at a time. The response says how many remain.
 *  - A coupon is anonymous (no customer binding; there is no auth), single use,
 *    applies x% to the whole order subtotal, and never expires.
 */
export class CouponService {
  constructor(
    private readonly db: Db,
    private readonly everyNOrders: number,
    private readonly discountPercent: number,
  ) {}

  list(): CouponView[] {
    const rows = this.db
      .prepare(`SELECT * FROM coupons ORDER BY milestone_number`)
      .all() as CouponRow[];
    return rows.map(toCouponView);
  }

  get(code: string): CouponView {
    const row = this.db
      .prepare(`SELECT * FROM coupons WHERE code = ?`)
      .get(normaliseCouponCode(code)) as CouponRow | undefined;
    if (!row) throw Errors.couponInvalid(code);
    return toCouponView(row);
  }

  milestoneStatus(): MilestoneStatus {
    const { totalOrders } = this.db
      .prepare(`SELECT COUNT(*) AS totalOrders FROM orders`)
      .get() as { totalOrders: number };
    const { couponsGenerated } = this.db
      .prepare(`SELECT COUNT(*) AS couponsGenerated FROM coupons`)
      .get() as { couponsGenerated: number };
    const milestonesReached = Math.floor(totalOrders / this.everyNOrders);
    const remainder = totalOrders % this.everyNOrders;
    return {
      everyNOrders: this.everyNOrders,
      discountPercent: this.discountPercent,
      totalOrders,
      milestonesReached,
      couponsGenerated,
      unrewardedMilestones: milestonesReached - couponsGenerated,
      ordersUntilNextMilestone: remainder === 0 ? this.everyNOrders : this.everyNOrders - remainder,
    };
  }

  /**
   * Generate the coupon for the lowest unrewarded milestone, or fail with 409
   * if none is eligible. Runs under BEGIN IMMEDIATE so two concurrent admin
   * requests cannot both observe "milestone 1 is unrewarded"; the UNIQUE
   * constraint on milestone_number is the last line of defence.
   */
  generate(): GenerateResult {
    const tx = this.db.transaction((): GenerateResult => {
      const before = this.milestoneStatus();
      if (before.unrewardedMilestones <= 0) {
        throw Errors.milestoneNotReached({ ...before });
      }
      // Coupons are always generated lowest-milestone-first, so the next
      // milestone to reward is max(existing) + 1.
      const { maxMilestone } = this.db
        .prepare(`SELECT COALESCE(MAX(milestone_number), 0) AS maxMilestone FROM coupons`)
        .get() as { maxMilestone: number };
      const milestoneNumber = maxMilestone + 1;
      const code = this.newCode(milestoneNumber);
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO coupons (code, milestone_number, milestone_order_number, discount_percent, status,
                                redeemed_by_order_id, created_at, redeemed_at)
           VALUES (?, ?, ?, ?, 'AVAILABLE', NULL, ?, NULL)`,
        )
        .run(code, milestoneNumber, milestoneNumber * this.everyNOrders, this.discountPercent, now);
      return { coupon: this.get(code), milestones: this.milestoneStatus() };
    });
    return tx.immediate();
  }

  private newCode(milestoneNumber: number): string {
    // Human-friendly: SAVE10-M3-7F2A9C. Random suffix makes codes unguessable.
    const suffix = randomBytes(3).toString("hex").toUpperCase();
    return `SAVE${this.discountPercent}-M${milestoneNumber}-${suffix}`;
  }
}
