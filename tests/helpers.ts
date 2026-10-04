import request from "supertest";
import { createApp, type AppContext } from "../src/app";
import type { AppConfig } from "../src/config";
import type { SeedProduct } from "../src/db/seed";

export const TEST_PRODUCTS: SeedProduct[] = [
  { id: "p-cheap", name: "Cheap Thing", priceMinor: 499, inventory: 1000 },
  { id: "p-shirt", name: "Shirt", priceMinor: 1999, inventory: 100 },
  { id: "p-scarce", name: "Scarce Thing", priceMinor: 8999, inventory: 3 },
  { id: "p-odd", name: "Odd Price", priceMinor: 5, inventory: 50 },
];

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    dbPath: ":memory:",
    couponEveryNOrders: 3,
    couponDiscountPercent: 10,
    currency: "USD",
    ...overrides,
  };
}

export function makeApp(overrides: Partial<AppConfig> = {}, seed: SeedProduct[] = TEST_PRODUCTS): AppContext {
  return createApp({ config: testConfig(overrides), seed });
}

/** Thin HTTP client over supertest for readable tests. */
export class Client {
  constructor(private readonly ctx: AppContext) {}

  get http() {
    return request(this.ctx.app);
  }

  async createCart(): Promise<string> {
    const res = await this.http.post("/carts").expect(201);
    return res.body.id as string;
  }

  async addItem(cartId: string, productId: string, quantity: number) {
    return this.http.post(`/carts/${cartId}/items`).send({ productId, quantity });
  }

  async checkout(cartId: string, couponCode?: string | null) {
    const body = couponCode === undefined ? {} : { couponCode };
    return this.http.post(`/carts/${cartId}/checkout`).send(body);
  }

  /** Create a cart with the given lines and check it out, returning the order. */
  async placeOrder(lines: Array<[string, number]>, couponCode?: string) {
    const cartId = await this.createCart();
    for (const [productId, quantity] of lines) {
      await this.addItem(cartId, productId, quantity).then((r) => {
        if (r.status !== 201) throw new Error(`addItem failed: ${JSON.stringify(r.body)}`);
      });
    }
    const res = await this.checkout(cartId, couponCode);
    if (res.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async generateCoupon() {
    return this.http.post("/admin/coupons");
  }

  async inventory(productId: string): Promise<number> {
    const res = await this.http.get(`/products/${productId}`).expect(200);
    return res.body.availableInventory as number;
  }

  async report() {
    const res = await this.http.get("/admin/report").expect(200);
    return res.body;
  }
}
