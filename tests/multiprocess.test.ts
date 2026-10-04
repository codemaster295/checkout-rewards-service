import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServices, type Services } from "../src/app";
import { openDatabase, type Db } from "../src/db/connection";
import { seedProducts } from "../src/db/seed";
import { TEST_PRODUCTS, testConfig } from "./helpers";

/**
 * Multi-connection contention. Several worker threads each open their own
 * connection to the same SQLite file and check out simultaneously. This is the
 * closest single-machine analogue to "multiple application instances sharing a
 * database" and validates that the invariants rest on the database (write
 * lock + conditional UPDATE + UNIQUE constraints), not on Node being
 * single-threaded.
 */
const config = testConfig({ couponEveryNOrders: 2 });
let dir: string;
let dbPath: string;
let db: Db;
let services: Services;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-mp-"));
  dbPath = path.join(dir, "store.sqlite");
  db = openDatabase(dbPath);
  seedProducts(db, TEST_PRODUCTS);
  services = buildServices(db, config);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type WorkerResult =
  | { cartId: string; ok: true; orderId: string; replayed: boolean; orderNumber: number }
  | { cartId: string; ok: false; code: string }
  | { generate: true; ok: true; code: string; milestone: number }
  | { generate: true; ok: false; code: string };

function runWorker(data: Record<string, unknown>): Promise<WorkerResult[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, "workers", "checkoutWorker.cjs"), {
      workerData: { dbPath, config, ...data },
    });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => code !== 0 && reject(new Error(`worker exited with ${code}`)));
  });
}

function chunk<T>(items: T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, i) => out[i % parts]!.push(item));
  return out;
}

describe("concurrent operations across independent DB connections", () => {
  it("4 workers x 10 carts racing for 3 units -> exactly 3 orders, inventory 0", async () => {
    const cartIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const cart = services.carts.create();
      services.carts.addItem(cart.id, "p-scarce", 1);
      cartIds.push(cart.id);
    }

    const results = (await Promise.all(chunk(cartIds, 4).map((ids) => runWorker({ cartIds: ids })))).flat();

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok) as Array<{ ok: false; code: string }>;
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(37);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["INSUFFICIENT_INVENTORY"]));

    expect(services.products.get("p-scarce").availableInventory).toBe(0);
    expect(services.orders.list()).toHaveLength(3);
    expect(services.orders.list().map((o) => o.orderNumber)).toEqual([1, 2, 3]);
  });

  it("the same cart checked out from 4 workers at once yields one order and 3 replays", async () => {
    const cart = services.carts.create();
    services.carts.addItem(cart.id, "p-shirt", 1);

    const results = (
      await Promise.all(Array.from({ length: 4 }, () => runWorker({ cartIds: [cart.id] })))
    ).flat() as Array<{ ok: true; orderId: string; replayed: boolean }>;

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(3);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(services.products.get("p-shirt").availableInventory).toBe(99);
  });

  it("one coupon offered by 6 carts across 3 workers is redeemed exactly once", async () => {
    services.checkout.checkout({ cartId: seedCart("p-cheap") });
    services.checkout.checkout({ cartId: seedCart("p-cheap") });
    const { coupon } = services.coupons.generate();

    const cartIds = Array.from({ length: 6 }, () => seedCart("p-cheap"));
    const results = (
      await Promise.all(chunk(cartIds, 3).map((ids) => runWorker({ cartIds: ids, couponCode: coupon.code })))
    ).flat();

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const codes = results.filter((r) => !r.ok).map((r) => (r as { code: string }).code);
    expect(codes).toEqual(Array(5).fill("COUPON_ALREADY_REDEEMED"));

    expect(services.coupons.get(coupon.code).status).toBe("REDEEMED");
    // Losers kept their stock: 2 setup orders + 1 winner = 3 units sold.
    expect(services.products.get("p-cheap").availableInventory).toBe(1000 - 3);
    expect(services.orders.list()).toHaveLength(3);
  });

  it("concurrent coupon generation across workers never double-rewards a milestone", async () => {
    for (let i = 0; i < 6; i++) services.checkout.checkout({ cartId: seedCart("p-cheap") });
    // 6 orders, n=2 -> 3 milestones outstanding. 4 workers x 3 attempts = 12 attempts.
    const results = (await Promise.all(Array.from({ length: 4 }, () => runWorker({ generateCoupons: 3 })))).flat();

    const generated = results.filter((r) => r.ok) as Array<{ milestone: number }>;
    expect(generated).toHaveLength(3);
    expect(generated.map((g) => g.milestone).sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
    expect(services.coupons.list()).toHaveLength(3);
  });

  function seedCart(productId: string): string {
    const cart = services.carts.create();
    services.carts.addItem(cart.id, productId, 1);
    return cart.id;
  }
});
