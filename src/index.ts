import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const { app, db } = createApp({ config });

const server = app.listen(config.port, () => {
  console.log(
    `checkout-rewards-service listening on http://localhost:${config.port} ` +
      `(db=${config.dbPath}, coupon every ${config.couponEveryNOrders} orders, ${config.couponDiscountPercent}% off)`,
  );
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
