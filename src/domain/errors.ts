/**
 * Error model.
 *
 * Every failure the API can produce is an `AppError` with a stable machine
 * readable `code`, an HTTP status, a human readable message and optional
 * structured `details`. Handlers never build error bodies by hand; the error
 * middleware serialises these uniformly as:
 *
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 *
 * Status conventions:
 *   400  malformed request (shape/type errors)                 -> VALIDATION_ERROR
 *   404  the resource addressed by the URL does not exist
 *   409  the request is well formed but conflicts with state    (inventory, already
 *        checked out, coupon already redeemed, milestone not reached)
 *   422  the request is well formed but semantically unusable  (empty cart, body
 *        references an unknown product / coupon)
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CART_NOT_FOUND"
  | "CART_ITEM_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "CART_EMPTY"
  | "CART_ALREADY_CHECKED_OUT"
  | "INSUFFICIENT_INVENTORY"
  | "COUPON_INVALID"
  | "COUPON_ALREADY_REDEEMED"
  | "MILESTONE_NOT_REACHED"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const Errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(400, "VALIDATION_ERROR", message, details),

  cartNotFound: (cartId: string) =>
    new AppError(404, "CART_NOT_FOUND", `Cart ${cartId} does not exist`, { cartId }),

  cartItemNotFound: (cartId: string, productId: string) =>
    new AppError(404, "CART_ITEM_NOT_FOUND", `Product ${productId} is not in cart ${cartId}`, {
      cartId,
      productId,
    }),

  orderNotFound: (orderId: string) =>
    new AppError(404, "ORDER_NOT_FOUND", `Order ${orderId} does not exist`, { orderId }),

  productNotFound: (productId: string, status: 404 | 422 = 404) =>
    new AppError(status, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist`, { productId }),

  cartEmpty: (cartId: string) =>
    new AppError(422, "CART_EMPTY", `Cart ${cartId} has no items; nothing to check out`, { cartId }),

  cartAlreadyCheckedOut: (cartId: string, orderId: string | null) =>
    new AppError(
      409,
      "CART_ALREADY_CHECKED_OUT",
      `Cart ${cartId} has already been checked out and can no longer be modified`,
      { cartId, orderId },
    ),

  insufficientInventory: (shortfalls: InventoryShortfall[]) =>
    new AppError(
      409,
      "INSUFFICIENT_INVENTORY",
      "One or more items exceed the available inventory",
      { items: shortfalls },
    ),

  couponInvalid: (code: string) =>
    new AppError(422, "COUPON_INVALID", `Coupon ${code} does not exist`, { couponCode: code }),

  couponAlreadyRedeemed: (code: string) =>
    new AppError(409, "COUPON_ALREADY_REDEEMED", `Coupon ${code} has already been redeemed`, {
      couponCode: code,
    }),

  milestoneNotReached: (details: Record<string, unknown>) =>
    new AppError(
      409,
      "MILESTONE_NOT_REACHED",
      "No unrewarded order milestone has been reached yet",
      details,
    ),

  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError(409, "CONFLICT", message, details),

  notFound: (message = "Resource not found") => new AppError(404, "NOT_FOUND", message),
};

export interface InventoryShortfall {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}
