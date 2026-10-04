import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app";
import { Client, makeApp } from "./helpers";

let ctx: AppContext;
let c: Client;

// n = 3, x = 10 (see helpers.testConfig)
beforeAll(() => {
  ctx = makeApp();
  c = new Client(ctx);
});
afterAll(() => ctx.db.close());

describe("coupon milestones", () => {
  it("cannot generate before the milestone and generates exactly once per milestone", async () => {
    let res = await c.generateCoupon();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MILESTONE_NOT_REACHED");
    expect(res.body.error.details).toMatchObject({ totalOrders: 0, ordersUntilNextMilestone: 3 });

    await c.placeOrder([["p-cheap", 1]]);
    await c.placeOrder([["p-cheap", 1]]);
    res = await c.generateCoupon();
    expect(res.status).toBe(409);
    expect(res.body.error.details.ordersUntilNextMilestone).toBe(1);

    await c.placeOrder([["p-cheap", 1]]); // order #3 -> milestone 1
    res = await c.generateCoupon();
    expect(res.status).toBe(201);
    expect(res.body.coupon).toMatchObject({
      milestoneNumber: 1,
      milestoneOrderNumber: 3,
      discountPercent: 10,
      status: "AVAILABLE",
    });
    expect(res.body.milestones.unrewardedMilestones).toBe(0);

    // Same milestone cannot be rewarded twice.
    res = await c.generateCoupon();
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ milestonesReached: 1, couponsGenerated: 1 });
  });

  it("catches up one milestone per call when several are outstanding", async () => {
    // Now at 3 orders / 1 coupon. Place 6 more -> 9 orders -> milestones 2 and 3 outstanding.
    for (let i = 0; i < 6; i++) await c.placeOrder([["p-cheap", 1]]);

    let res = await c.generateCoupon();
    expect(res.status).toBe(201);
    expect(res.body.coupon.milestoneNumber).toBe(2);
    expect(res.body.milestones.unrewardedMilestones).toBe(1);

    res = await c.generateCoupon();
    expect(res.status).toBe(201);
    expect(res.body.coupon.milestoneNumber).toBe(3);

    res = await c.generateCoupon();
    expect(res.status).toBe(409);
  });
});

describe("coupon redemption", () => {
  async function freshCoupon(): Promise<string> {
    // Place orders until a new milestone is available, then generate.
    for (;;) {
      const res = await c.generateCoupon();
      if (res.status === 201) return res.body.coupon.code as string;
      await c.placeOrder([["p-cheap", 1]]);
    }
  }

  it("applies a deterministic, half-up rounded discount and records it on the order", async () => {
    const code = await freshCoupon();
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-shirt", 1); // 1999 -> 10% = 199.9 -> 200

    const res = await c.checkout(cartId, code.toLowerCase()); // case-insensitive
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subtotalCents: 1999,
      discountCents: 200,
      totalCents: 1799,
      discount: { couponCode: code, percent: 10, amountCents: 200 },
    });

    const coupon = await c.http.get(`/admin/coupons/${code}`).expect(200);
    expect(coupon.body).toMatchObject({ status: "REDEEMED", redeemedByOrderId: res.body.id });
  });

  it("rejects unknown and already-redeemed coupons distinguishably", async () => {
    const code = await freshCoupon();
    await c.placeOrder([["p-cheap", 1]], code);

    const cartId = await c.createCart();
    await c.addItem(cartId, "p-cheap", 1);

    let res = await c.checkout(cartId, code);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COUPON_ALREADY_REDEEMED");

    res = await c.checkout(cartId, "NOPE-123");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("COUPON_INVALID");

    res = await c.checkout(cartId, "");
    expect(res.status).toBe(400);

    // Cart is still open and nothing was charged.
    const view = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(view.body.status).toBe("ACTIVE");
  });

  it("is not consumed by a checkout that fails for another reason", async () => {
    const code = await freshCoupon();
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-scarce", 2);
    // Drain the scarce stock behind the cart's back.
    await c.http.patch("/admin/products/p-scarce").send({ inventory: 1 }).expect(200);

    const res = await c.checkout(cartId, code);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");

    const coupon = await c.http.get(`/admin/coupons/${code}`).expect(200);
    expect(coupon.body.status).toBe("AVAILABLE");
    expect(coupon.body.redeemedByOrderId).toBeNull();

    // And it is still usable once the problem is fixed.
    await c.http.put(`/carts/${cartId}/items/p-scarce`).send({ quantity: 1 }).expect(200);
    const ok = await c.checkout(cartId, code);
    expect(ok.status).toBe(201);
    expect(ok.body.discount.couponCode).toBe(code);
  });

  it("retrying a successful coupon checkout replays instead of failing on the used coupon", async () => {
    const code = await freshCoupon();
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-cheap", 1);
    const first = await c.checkout(cartId, code);
    expect(first.status).toBe(201);

    const retry = await c.checkout(cartId, code);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    const withoutCoupon = await c.checkout(cartId);
    expect(withoutCoupon.status).toBe(409); // different terms
  });

  it("never drives a total negative, even at 100% off a 1-cent order", async () => {
    const local = makeApp({ couponEveryNOrders: 1, couponDiscountPercent: 100 });
    const lc = new Client(local);
    try {
      await lc.placeOrder([["p-odd", 1]]);
      const gen = await lc.generateCoupon();
      expect(gen.status).toBe(201);
      const order = await lc.placeOrder([["p-odd", 1]], gen.body.coupon.code);
      expect(order).toMatchObject({ subtotalCents: 5, discountCents: 5, totalCents: 0 });
    } finally {
      local.db.close();
    }
  });
});
