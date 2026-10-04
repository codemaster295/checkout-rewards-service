import type { ZodTypeAny, z } from "zod";
import { Errors } from "../domain/errors";

/** Parse with a zod schema, converting failures into a 400 VALIDATION_ERROR. */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, input: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
  throw Errors.validation(`Invalid ${where}`, { issues });
}
