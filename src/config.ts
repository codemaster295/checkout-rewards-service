/**
 * Runtime configuration. Everything is read from the environment with safe
 * defaults so the service runs with zero setup.
 */
export interface AppConfig {
  /** TCP port for the HTTP server. */
  port: number;
  /** SQLite file path, or ":memory:" for an ephemeral database. */
  dbPath: string;
  /** Every nth successfully placed order unlocks one coupon (n). */
  couponEveryNOrders: number;
  /** Percentage discount granted by a coupon (x), integer 1..100. */
  couponDiscountPercent: number;
  /** ISO-4217 code reported alongside amounts. Amounts are always integer minor units. */
  currency: string;
}

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}="${raw}": expected an integer in [${min}, ${max}]`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intFromEnv(env, "PORT", 3000, 1, 65535),
    dbPath: env.DB_PATH ?? "data/store.sqlite",
    couponEveryNOrders: intFromEnv(env, "COUPON_EVERY_N_ORDERS", 5, 1, 1_000_000),
    couponDiscountPercent: intFromEnv(env, "COUPON_DISCOUNT_PERCENT", 10, 1, 100),
    currency: env.CURRENCY ?? "USD",
  };
}
