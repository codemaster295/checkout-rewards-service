import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app";
import { Client, makeApp } from "./helpers";

/**
 * Overlapping requests through the HTTP layer in a single process. Node's
 * event loop interleaves request I/O, but each checkout transaction is
 * synchronous, so these demonstrate the invariants hold when many clients
 * race. For true multi-connection contention see multiprocess.test.ts.
 */
let ctx: AppContext;
let c: Client;

beforeAll(() => {
  ctx = makeApp();
  c = new Client(ctx);
});
afterAll(() => ctx.db.close());

describe("concurrent operations (single process)", () => {
  it("never oversells: 20 carts race for 3 units -> exactly 3 orders, inventory 0", async () => {
    const cartIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await c.createCart();
      await c.addItem(id, "p-scarce", 1).then((r) => expect(r.status).toBe(201));
      cartIds.push(id);
    }

    const results = await Promise.all(cartIds.map((id) => c.checkout(id)));
    const ok = results.filter((r) => r.status === 201);
    const short = results.filter((r) => r.status === 409);

    expect(ok).toHaveLength(3);
    expect(short).toHaveLength(17);
    for (const r of short) expect(r.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(await c.inventory("p-scarce")).toBe(0);

    // Order numbers are dense and unique.
    const numbers = ok.map((r) => r.body.orderNumber as number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);

    // Losers' carts remain open so the customer can adjust.
    for (const id of cartIds.filter((_, i) => results[i]!.status === 409)) {
      const view = await c.http.get(`/carts/${id}`).expect(200);
      expect(view.body.status).toBe("ACTIVE");
    }
  });

  it("repeated checkout of the same cart in parallel produces exactly one order", async () => {
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-shirt", 2);
    const stockBefore = await c.inventory("p-shirt");

    const results = await Promise.all(Array.from({ length: 15 }, () => c.checkout(cartId)));
    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);

    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(14);
    const orderId = created[0]!.body.id;
    for (const r of replayed) {
      expect(r.body.id).toBe(orderId);
      expect(r.headers["idempotent-replayed"]).toBe("true");
    }
    expect(await c.inventory("p-shirt")).toBe(stockBefore - 2);
  });

  it("a coupon presented by two concurrent checkouts is redeemed exactly once, and the loser keeps its stock", async () => {
    // Reach a milestone (n = 3).
    for (let i = 0; i < 3; i++) await c.placeOrder([["p-cheap", 1]]);
    const gen = await c.generateCoupon();
    expect(gen.status).toBe(201);
    const code = gen.body.coupon.code as string;

    const a = await c.createCart();
    const b = await c.createCart();
    await c.addItem(a, "p-shirt", 1);
    await c.addItem(b, "p-cheap", 3);
    const shirtBefore = await c.inventory("p-shirt");
    const cheapBefore = await c.inventory("p-cheap");

    const [ra, rb] = await Promise.all([c.checkout(a, code), c.checkout(b, code)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    const winner = ra.status === 201 ? ra : rb;
    expect(loser.body.error.code).toBe("COUPON_ALREADY_REDEEMED");
    expect(winner.body.discount.couponCode).toBe(code);

    // Only the winner's inventory moved; the loser's cart is still open.
    if (winner.body.cartId === a) {
      expect(await c.inventory("p-shirt")).toBe(shirtBefore - 1);
      expect(await c.inventory("p-cheap")).toBe(cheapBefore);
    } else {
      expect(await c.inventory("p-cheap")).toBe(cheapBefore - 3);
      expect(await c.inventory("p-shirt")).toBe(shirtBefore);
    }
    const loserCartId = winner.body.cartId === a ? b : a;
    const loserCart = await c.http.get(`/carts/${loserCartId}`).expect(200);
    expect(loserCart.body.status).toBe("ACTIVE");

    const coupon = await c.http.get(`/admin/coupons/${code}`).expect(200);
    expect(coupon.body.status).toBe("REDEEMED");
    expect(coupon.body.redeemedByOrderId).toBe(winner.body.id);
  });

  it("concurrent coupon generation for one milestone yields exactly one coupon", async () => {
    // Advance to the next milestone.
    for (;;) {
      const status = await c.http.get("/admin/coupons").expect(200);
      if (status.body.milestones.unrewardedMilestones > 0) break;
      await c.placeOrder([["p-cheap", 1]]);
    }
    const before = (await c.http.get("/admin/coupons")).body.coupons.length as number;

    const results = await Promise.all(Array.from({ length: 10 }, () => c.generateCoupon()));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);

    const after = (await c.http.get("/admin/coupons")).body.coupons.length as number;
    expect(after).toBe(before + 1);
  });
});
