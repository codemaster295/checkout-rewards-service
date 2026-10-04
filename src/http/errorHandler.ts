import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, Errors } from "../domain/errors";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(Errors.notFound(`No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  // body-parser signals malformed JSON with `type: 'entity.parse.failed'`.
  if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json(Errors.validation("Request body is not valid JSON").toJSON());
    return;
  }
  console.error("Unhandled error", err);
  res.status(500).json(new AppError(500, "INTERNAL_ERROR", "Unexpected server error").toJSON());
};
