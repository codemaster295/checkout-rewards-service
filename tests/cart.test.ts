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

describe("cart lifecycle", () => {
  it("creates, adds (merging duplicates), updates, removes and totals correctly", async () => {
    const cartId = await c.createCart();

    let res = await c.addItem(cartId, "p-shirt", 2);
    expect(res.status).toBe(201);
    res = await c.addItem(cartId, "p-shirt", 1); // merge -> 3
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.items[0].lineTotalCents).toBe(1999 * 3);

    await c.addItem(cartId, "p-cheap", 4);
    res = await c.http.put(`/carts/${cartId}/items/p-cheap`).send({ quantity: 1 }).expect(200);
    expect(res.body.subtotalCents).toBe(1999 * 3 + 499);
    expect(res.body.itemCount).toBe(4);

    res = await c.http.delete(`/carts/${cartId}/items/p-shirt`).expect(200);
    expect(res.body.items.map((i: { productId: string }) => i.productId)).toEqual(["p-cheap"]);

    const view = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(view.body.subtotalCents).toBe(499);
    expect(view.body.status).toBe("ACTIVE");
  });

  it("rejects invalid products and quantities with distinguishable errors", async () => {
    const cartId = await c.createCart();

    let res = await c.addItem(cartId, "does-not-exist", 1);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PRODUCT_NOT_FOUND");

    for (const bad of [0, -1, 1.5, "2", null, 1000]) {
      res = await c.http.post(`/carts/${cartId}/items`).send({ productId: "p-shirt", quantity: bad });
      expect(res.status, `quantity=${String(bad)}`).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }

    res = await c.http.post(`/carts/${cartId}/items`).send({ productId: "p-shirt", quantity: 1, extra: true });
    expect(res.status).toBe(400); // strict schema: unknown fields rejected rather than ignored

    res = await c.http
      .post(`/carts/${cartId}/items`)
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);

    // Nothing leaked into the cart.
    const view = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(view.body.items).toEqual([]);
  });

  it("refuses to add more than available inventory (early feedback)", async () => {
    const cartId = await c.createCart();
    const res = await c.addItem(cartId, "p-scarce", 4);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(res.body.error.details.items[0]).toMatchObject({ productId: "p-scarce", requested: 4, available: 3 });

    // merging must consider the combined quantity
    await c.addItem(cartId, "p-scarce", 2).then((r) => expect(r.status).toBe(201));
    const merged = await c.addItem(cartId, "p-scarce", 2);
    expect(merged.status).toBe(409);
  });

  it("404s on unknown cart / item in URL", async () => {
    let res = await c.http.get("/carts/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CART_NOT_FOUND");

    const cartId = await c.createCart();
    res = await c.http.put(`/carts/${cartId}/items/p-shirt`).send({ quantity: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CART_ITEM_NOT_FOUND");
    res = await c.http.delete(`/carts/${cartId}/items/p-shirt`);
    expect(res.status).toBe(404);
  });

  it("reflects live price and availability changes made after items were added", async () => {
    const cartId = await c.createCart();
    await c.addItem(cartId, "p-odd", 10); // price 5, inventory 50

    await c.http.patch("/admin/products/p-odd").send({ unitPriceCents: 7, inventory: 4 }).expect(200);

    const view = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(view.body.items[0]).toMatchObject({
      unitPriceCents: 7, // not locked at add time
      lineTotalCents: 70,
      availableInventory: 4,
      inStock: false,
    });
    expect(view.body.warnings).toEqual([
      { code: "INSUFFICIENT_INVENTORY", productId: "p-odd", requested: 10, available: 4 },
    ]);

    // Checkout now fails and leaves the cart untouched for the client to fix.
    const res = await c.checkout(cartId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    const after = await c.http.get(`/carts/${cartId}`).expect(200);
    expect(after.body.status).toBe("ACTIVE");
    expect(after.body.items[0].quantity).toBe(10);
    expect(await c.inventory("p-odd")).toBe(4);

    // Fixing the quantity lets it through at the new price.
    await c.http.put(`/carts/${cartId}/items/p-odd`).send({ quantity: 4 }).expect(200);
    const ok = await c.checkout(cartId);
    expect(ok.status).toBe(201);
    expect(ok.body.items[0]).toMatchObject({ unitPriceCents: 7, quantity: 4, lineTotalCents: 28 });
  });
});
