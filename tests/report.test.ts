import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app";
import { Client, makeApp } from "./helpers";

let ctx: AppContext;
let c: Client;

beforeAll(() => {
  ctx = makeApp({ couponEveryNOrders: 2 });
  c = new Client(ctx);
});
afterAll(() => ctx.db.close());

describe("admin report", () => {
  it("starts empty and is stable across repeated reads", async () => {
    const r1 = await c.report();
    expect(r1).toMatchObject({
      orders: { totalPlaced: 0 },
      revenue: { grossCents: 0, discountsCents: 0, netCents: 0 },
      purchasedQuantityByProduct: [],
      coupons: { generated: 0, available: 0, redeemed: 0 },
    });
    const r2 = await c.report();
    expect({ ...r2, generatedAt: undefined }).toEqual({ ...r1, generatedAt: undefined });
  });

  it("reconciles with the orders and coupons the system returns", async () => {
    await c.placeOrder([["p-shirt", 2], ["p-cheap", 1]]); // 4497
    await c.placeOrder([["p-scarce", 1]]); // 8999 -> milestone 1
    const gen = await c.generateCoupon();
    expect(gen.status).toBe(201);
    const code = gen.body.coupon.code as string;
    await c.placeOrder([["p-shirt", 1]], code); // 1999 - 200 = 1799
    await c.placeOrder([["p-cheap", 5]]); // 2495 -> milestone 2 (unrewarded)

    // A failed checkout must not appear anywhere in the report.
    const failing = await c.createCart();
    await c.addItem(failing, "p-scarce", 2);
    await c.http.patch("/admin/products/p-scarce").send({ inventory: 1 });
    await c.checkout(failing).then((r) => expect(r.status).toBe(409));

    const report = await c.report();
    const orders = (await c.http.get("/admin/orders").expect(200)).body.orders as Array<{
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
      items: Array<{ productId: string; quantity: number }>;
    }>;
    const coupons = (await c.http.get("/admin/coupons").expect(200)).body.coupons as Array<{ status: string }>;

    expect(orders).toHaveLength(4);
    expect(report.orders.totalPlaced).toBe(4);

    const gross = orders.reduce((s, o) => s + o.subtotalCents, 0);
    const discounts = orders.reduce((s, o) => s + o.discountCents, 0);
    const net = orders.reduce((s, o) => s + o.totalCents, 0);
    expect(report.revenue).toEqual({ grossCents: gross, discountsCents: discounts, netCents: net });
    expect(report.revenue).toEqual({
      grossCents: 4497 + 8999 + 1999 + 2495,
      discountsCents: 200,
      netCents: 4497 + 8999 + 1799 + 2495,
    });
    expect(report.revenue.grossCents - report.revenue.discountsCents).toBe(report.revenue.netCents);

    const qty: Record<string, number> = {};
    for (const o of orders) for (const i of o.items) qty[i.productId] = (qty[i.productId] ?? 0) + i.quantity;
    const reported = Object.fromEntries(
      report.purchasedQuantityByProduct.map((p: { productId: string; quantity: number }) => [p.productId, p.quantity]),
    );
    expect(reported).toEqual(qty);
    expect(reported).toEqual({ "p-shirt": 3, "p-cheap": 6, "p-scarce": 1 });

    expect(report.coupons).toEqual({
      generated: coupons.length,
      available: coupons.filter((x) => x.status === "AVAILABLE").length,
      redeemed: coupons.filter((x) => x.status === "REDEEMED").length,
    });
    expect(report.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
    expect(report.milestones).toMatchObject({ milestonesReached: 2, couponsGenerated: 1, unrewardedMilestones: 1 });

    // Reading the report again changes nothing.
    const again = await c.report();
    expect({ ...again, generatedAt: undefined }).toEqual({ ...report, generatedAt: undefined });
  });
});
