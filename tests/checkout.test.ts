import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app";
import { Client, makeApp } from "./helpers";

let ctx: AppContext;
let c: Client;

beforeAll(() => {
  ctx = makeApp();
  c = new Client(ctx);
});
afterAll(() => ctx.db.close());

describe("checkout", () => {
  it("creates an order with a full snapshot, decrements inventory, and closes the cart", async () => {
    const before = await c.inventory("p-shirt");
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-shirt", 2);
    await c.addItem(cartId, "p-cheap", 1);

    const res = await c.checkout(cartId);
    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("false");
    expect(res.headers.location).toBe(`/orders/${res.body.id}`);
    expect(res.body).toMatchObject({
      cartId,
      status: "PLACED",
      subtotalCents: 1999 * 2 + 499,
      discount: null,
      discountCents: 0,
      totalCents: 1999 * 2 + 499,
    });
    expect(res.body.items).toHaveLength(2);

    expect(await c.inventory("p-shirt")).toBe(before - 2);

    const cart = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(cart.body.status).toBe("CHECKED_OUT");
    expect(cart.body.orderId).toBe(res.body.id);

    const order = await c.http.get(`/orders/${res.body.id}`).expect(200);
    expect(order.body).toEqual(res.body);
  });

  it("order snapshot survives later product changes", async () => {
    const order = await c.placeOrder([["p-cheap", 2]]);
    await c.http.patch("/admin/products/p-cheap").send({ unitPriceCents: 999 }).expect(200);

    const fetched = await c.http.get(`/orders/${order.id}`).expect(200);
    expect(fetched.body.items[0]).toMatchObject({ productName: "Cheap Thing", unitPriceCents: 499, lineTotalCents: 998 });
    expect(fetched.body.totalCents).toBe(998);

    await c.http.patch("/admin/products/p-cheap").send({ unitPriceCents: 499 }).expect(200);
  });

  it("is idempotent: retrying returns the same order (200) without new side effects", async () => {
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-shirt", 1);
    const stockBefore = await c.inventory("p-shirt");

    const first = await c.checkout(cartId);
    expect(first.status).toBe(201);

    const retry = await c.checkout(cartId);
    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(first.body.id);

    const retryNoBody = await c.http.post(`/carts/${cartId}/checkout`);
    expect(retryNoBody.status).toBe(200);
    expect(retryNoBody.body.id).toBe(first.body.id);

    expect(await c.inventory("p-shirt")).toBe(stockBefore - 1);
    const orders = await c.http.get("/admin/orders").expect(200);
    expect(orders.body.orders.filter((o: { cartId: string }) => o.cartId === cartId)).toHaveLength(1);
  });

  it("rejects a 'retry' with different terms rather than silently replaying", async () => {
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-shirt", 1);
    const first = await c.checkout(cartId);
    expect(first.status).toBe(201);

    const different = await c.checkout(cartId, "SOME-COUPON");
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
    expect(different.body.error.details.orderId).toBe(first.body.id);
  });

  it("refuses to check out an empty cart or mutate a checked-out cart", async () => {
    const cartId = await c.createCart();
    let res = await c.checkout(cartId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CART_EMPTY");

    await c.addItem(cartId, "p-cheap", 1);
    await c.checkout(cartId).then((r) => expect(r.status).toBe(201));

    res = await c.addItem(cartId, "p-cheap", 1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
    res = await c.http.put(`/carts/${cartId}/items/p-cheap`).send({ quantity: 5 });
    expect(res.status).toBe(409);
    res = await c.http.delete(`/carts/${cartId}/items/p-cheap`);
    expect(res.status).toBe(409);
  });

  it("fails atomically on partial stock: no line is decremented if any line is short", async () => {
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-scarce", 3); // all remaining stock
    await c.addItem(cartId, "p-shirt", 1);

    // Someone else buys one scarce unit first.
    await c.placeOrder([["p-scarce", 1]]);

    const shirtBefore = await c.inventory("p-shirt");
    const res = await c.checkout(cartId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(res.body.error.details.items).toEqual([
      { productId: "p-scarce", productName: "Scarce Thing", requested: 3, available: 2 },
    ]);
    // The shirt line was processed in the same transaction and must be rolled back.
    expect(await c.inventory("p-shirt")).toBe(shirtBefore);
    expect(await c.inventory("p-scarce")).toBe(2);
  });

  it("404s for unknown orders and carts", async () => {
    let res = await c.http.get("/orders/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    res = await c.checkout("nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CART_NOT_FOUND");
  });
});
