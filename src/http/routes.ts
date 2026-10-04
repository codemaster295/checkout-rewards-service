import { Router } from "express";
import { z } from "zod";
import type { Services } from "../app";
import { MAX_LINE_QUANTITY } from "../services/cartService";
import { parseOrThrow } from "./validate";

const quantitySchema = z
  .number({ invalid_type_error: "quantity must be a number" })
  .int("quantity must be an integer")
  .min(1, "quantity must be at least 1")
  .max(MAX_LINE_QUANTITY, `quantity cannot exceed ${MAX_LINE_QUANTITY}`);

const addItemSchema = z
  .object({
    productId: z.string().min(1, "productId is required"),
    quantity: quantitySchema,
  })
  .strict();

const setQuantitySchema = z.object({ quantity: quantitySchema }).strict();

const checkoutSchema = z
  .object({
    couponCode: z.string().trim().min(1, "couponCode cannot be blank").max(64).nullable().optional(),
  })
  .strict()
  .default({});

const productPatchSchema = z
  .object({
    unitPriceCents: z.number().int().min(0).optional(),
    inventory: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((p) => p.unitPriceCents !== undefined || p.inventory !== undefined, {
    message: "Provide unitPriceCents and/or inventory",
  });

/**
 * Public (customer-facing) routes.
 */
export function publicRouter(s: Services): Router {
  const r = Router();

  r.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ---- Products ------------------------------------------------------------
  r.get("/products", (_req, res) => {
    res.json({ products: s.products.list() });
  });
  r.get("/products/:productId", (req, res) => {
    res.json(s.products.get(req.params.productId));
  });

  // ---- Carts ---------------------------------------------------------------
  r.post("/carts", (_req, res) => {
    res.status(201).json(s.carts.create());
  });
  r.get("/carts/:cartId", (req, res) => {
    res.json(s.carts.get(req.params.cartId));
  });
  r.post("/carts/:cartId/items", (req, res) => {
    const body = parseOrThrow(addItemSchema, req.body, "request body");
    res.status(201).json(s.carts.addItem(req.params.cartId, body.productId, body.quantity));
  });
  r.put("/carts/:cartId/items/:productId", (req, res) => {
    const body = parseOrThrow(setQuantitySchema, req.body, "request body");
    res.json(s.carts.setQuantity(req.params.cartId, req.params.productId, body.quantity));
  });
  r.delete("/carts/:cartId/items/:productId", (req, res) => {
    res.json(s.carts.removeItem(req.params.cartId, req.params.productId));
  });

  // ---- Checkout ------------------------------------------------------------
  r.post("/carts/:cartId/checkout", (req, res) => {
    const body = parseOrThrow(checkoutSchema, req.body ?? {}, "request body");
    const result = s.checkout.checkout({ cartId: req.params.cartId, couponCode: body.couponCode ?? null });
    res.setHeader("Idempotent-Replayed", result.replayed ? "true" : "false");
    res.setHeader("Location", `/orders/${result.order.id}`);
    res.status(result.replayed ? 200 : 201).json(result.order);
  });

  // ---- Orders --------------------------------------------------------------
  r.get("/orders/:orderId", (req, res) => {
    res.json(s.orders.get(req.params.orderId));
  });

  return r;
}

/**
 * Administrative routes. No authentication is implemented (out of scope); in
 * production this router would sit behind an auth middleware requiring an
 * admin role. Everything mounted here is considered privileged.
 */
export function adminRouter(s: Services): Router {
  const r = Router();

  r.post("/coupons", (_req, res) => {
    const result = s.coupons.generate();
    res.status(201).json(result);
  });
  r.get("/coupons", (_req, res) => {
    res.json({ coupons: s.coupons.list(), milestones: s.coupons.milestoneStatus() });
  });
  r.get("/coupons/:code", (req, res) => {
    res.json(s.coupons.get(req.params.code));
  });

  r.get("/orders", (_req, res) => {
    res.json({ orders: s.orders.list() });
  });

  r.get("/report", (_req, res) => {
    res.json(s.report.summary());
  });

  r.patch("/products/:productId", (req, res) => {
    const body = parseOrThrow(productPatchSchema, req.body, "request body");
    res.json(s.products.update(req.params.productId, body));
  });

  return r;
}
