import { z } from "zod";

export const Id = z.uuidv7();
export const IsoDateTime = z.iso.datetime({ offset: false });
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
export const HttpUrl = z.httpUrl();
export const NonEmpty = z.string().trim().min(1);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "expected ISO 4217 code");
export const PayPeriod = z.enum(["hour", "day", "week", "month", "year"]);

export const Compensation = z
  .object({
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    currency: CurrencyCode,
    period: PayPeriod,
  })
  .refine((c) => c.min === null || c.max === null || c.min <= c.max, {
    message: "min must be ≤ max",
  });
export type Compensation = z.infer<typeof Compensation>;

export const Sensitivity = z.enum(["none", "personal", "sensitive", "protected"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Actor = z.enum(["user", "system", "openai", "claude", "browser"]);
export type Actor = z.infer<typeof Actor>;
