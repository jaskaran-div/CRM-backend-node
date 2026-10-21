import { z } from "zod";
import { badRequest } from "./errors.js";
import { parseLocalDateInput, parseLocalDateTimeInput } from "./time.js";

// Field coercions mirroring Jackson's default leniency in the Spring backend, so existing
// frontend payloads keep working: numeric strings for ids, "" as null, numbers accepted where a
// string is expected, unknown properties ignored. Type mismatches -> 400.

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

export const zId = z.preprocess(
  (v) => (typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : emptyToNull(v)),
  z.number().int().safe().nullable(),
);

export const zInt = z.preprocess(
  (v) => {
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Math.trunc(Number(v.trim()));
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    return emptyToNull(v);
  },
  z.number().int().safe().nullable(),
);

export const zStr = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v === undefined ? null : v),
  z.string().nullable(),
);

export const zBool = z.preprocess((v) => (v === undefined ? null : v), z.boolean().nullable());

export const zEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(emptyToNull, z.enum(values).nullable());

export const zLocalDateTime = z.preprocess(emptyToNull, z.string().nullable()).transform((v, ctx) => {
  if (v == null) return null;
  try {
    return parseLocalDateTimeInput(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid date-time" });
    return z.NEVER;
  }
});

export const zLocalDate = z.preprocess(emptyToNull, z.string().nullable()).transform((v, ctx) => {
  if (v == null) return null;
  try {
    return parseLocalDateInput(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid date" });
    return z.NEVER;
  }
});

/** Parse a JSON object body. Missing fields become null (Jackson default). */
export function parseBody<S extends z.ZodRawShape>(shape: S, body: unknown): z.infer<z.ZodObject<S>> {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!obj) throw badRequest("Request body is required");
  const result = z.object(shape).safeParse(obj);
  if (!result.success) throw badRequest(describe(result.error));
  return result.data;
}

function describe(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid request body";
  const field = issue.path.join(".");
  return field ? `Invalid value for field '${field}'` : "Invalid request body";
}

/** Path variable of type Long. Spring returns 400 on a type mismatch. */
export function pathId(raw: unknown, name = "id"): number {
  if (typeof raw !== "string" || !/^-?\d{1,15}$/.test(raw)) throw badRequest(`Invalid value for path variable '${name}'`);
  return Number(raw);
}

/** Required @RequestParam Long. */
export function queryId(raw: unknown, name: string): number {
  if (raw == null || raw === "") throw badRequest(`Required parameter '${name}' is not present`);
  if (typeof raw !== "string" || !/^-?\d{1,15}$/.test(raw)) throw badRequest(`Invalid value for parameter '${name}'`);
  return Number(raw);
}

/** Enum taken from a path variable or query parameter. */
export function enumParam<T extends readonly string[]>(raw: unknown, values: T, name: string): T[number] {
  if (raw == null || raw === "") throw badRequest(`Required parameter '${name}' is not present`);
  if (typeof raw !== "string" || !values.includes(raw)) throw badRequest(`Invalid value for parameter '${name}'`);
  return raw as T[number];
}

/** Body that is a bare JSON string enum, e.g. "ENROLLED" (Spring @RequestBody Lead.LeadStatus). */
export function enumBody<T extends readonly string[]>(body: unknown, values: T, label: string): T[number] {
  if (body == null || body === "") throw badRequest(`${label} is required`);
  if (typeof body !== "string" || !values.includes(body)) throw badRequest(`Invalid value for ${label.toLowerCase()}`);
  return body as T[number];
}
