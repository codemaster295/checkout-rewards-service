import express, { type Express } from "express";
import type { AppConfig } from "./config";
import { openDatabase, type Db } from "./db/connection";
import { seedProducts, type SeedProduct } from "./db/seed";
import { errorHandler, notFoundHandler } from "./http/errorHandler";
import { adminRouter, publicRouter } from "./http/routes";
import { CartService } from "./services/cartService";
import { CheckoutService } from "./services/checkoutService";
import { CouponService } from "./services/couponService";
import { OrderService } from "./services/orderService";
import { ProductService } from "./services/productService";
import { ReportService } from "./services/reportService";

export interface Services {
  products: ProductService;
  carts: CartService;
  checkout: CheckoutService;
  orders: OrderService;
  coupons: CouponService;
  report: ReportService;
}

export interface AppContext {
  app: Express;
  db: Db;
  services: Services;
  config: AppConfig;
}

/** Wires services over an already-open database. */
export function buildServices(db: Db, config: AppConfig): Services {
  const products = new ProductService(db);
  const carts = new CartService(db, config.currency);
  const checkout = new CheckoutService(db, carts, config.currency);
  const orders = new OrderService(db);
  const coupons = new CouponService(db, config.couponEveryNOrders, config.couponDiscountPercent);
  const report = new ReportService(db, coupons, config.currency);
  return { products, carts, checkout, orders, coupons, report };
}

export interface CreateAppOptions {
  config: AppConfig;
  /** Override the seed catalogue (tests). `[]` disables seeding. */
  seed?: SeedProduct[];
}

export function createApp({ config, seed }: CreateAppOptions): AppContext {
  const db = openDatabase(config.dbPath);
  seedProducts(db, seed);
  const services = buildServices(db, config);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(publicRouter(services));
  app.use("/admin", adminRouter(services));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, db, services, config };
}
