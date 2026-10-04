/* eslint-disable @typescript-eslint/no-var-requires */
// Worker thread used by multiprocess.test.ts. Each worker opens its OWN SQLite
// connection to the shared database file and hammers checkout, so the
// contention is real (file/WAL locks + busy_timeout + conditional UPDATEs),
// not merely event-loop interleaving.
require("tsx/cjs");
const { parentPort, workerData } = require("node:worker_threads");
const { openDatabase } = require("../../src/db/connection.ts");
const { buildServices } = require("../../src/app.ts");

const { dbPath, config, cartIds, couponCode, generateCoupons } = workerData;
const db = openDatabase(dbPath);
const services = buildServices(db, config);

const results = [];
for (const cartId of cartIds ?? []) {
  try {
    const r = services.checkout.checkout({ cartId, couponCode: couponCode ?? null });
    results.push({ cartId, ok: true, orderId: r.order.id, replayed: r.replayed, orderNumber: r.order.orderNumber });
  } catch (err) {
    results.push({ cartId, ok: false, code: err.code ?? String(err) });
  }
}
for (let i = 0; i < (generateCoupons ?? 0); i++) {
  try {
    const r = services.coupons.generate();
    results.push({ generate: true, ok: true, code: r.coupon.code, milestone: r.coupon.milestoneNumber });
  } catch (err) {
    results.push({ generate: true, ok: false, code: err.code ?? String(err) });
  }
}

db.close();
parentPort.postMessage(results);
