import { z } from 'zod';

// ---------------------------------------------------------------------------
// MappingSpec — the JSON-serializable format Claude proposes, the operator
// reviews, and the worker applies. Lives in `MappingConfig.fields` in Postgres.
//
// Two kinds of entries:
//   - `fields[]`: scalar destination paths derived from source via `from`,
//     `template`, or `constant`. Optional `fallbackFrom` chain handles
//     "use email, or fall back to customer.email if null".
//   - `arrays[]`: iterate a source array, apply per-element field mappings,
//     and write to a destination array path.
//
// Paths use dot notation: `customer.email`, `line_items` (no array indices).
// Templates use `{path}` placeholders: `shopify-{id}`, `{first} {last}`.
// ---------------------------------------------------------------------------

const constantValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const fieldMappingSchema = z
  .object({
    to: z.string().min(1, '`to` is required'),
    from: z.string().optional(),
    template: z.string().optional(),
    constant: constantValueSchema.optional(),
    fallbackFrom: z.array(z.string()).optional(),
    rationale: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
  })
  .refine(
    (f) =>
      [f.from !== undefined, f.template !== undefined, f.constant !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: 'Each field must specify exactly one of `from`, `template`, `constant`.' },
  );

const arrayElementFieldSchema = z
  .object({
    to: z.string().min(1),
    from: z.string().optional(),
    template: z.string().optional(),
    constant: constantValueSchema.optional(),
  })
  .refine(
    (f) =>
      [f.from !== undefined, f.template !== undefined, f.constant !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: 'Each array field must specify exactly one of `from`, `template`, `constant`.' },
  );

const arrayMappingSchema = z.object({
  to: z.string().min(1),
  from: z.string().min(1),
  fields: z.array(arrayElementFieldSchema),
});

export const mappingSpecSchema = z.object({
  fields: z.array(fieldMappingSchema),
  arrays: z.array(arrayMappingSchema).optional(),
});

export type MappingSpec = z.infer<typeof mappingSpecSchema>;
export type FieldMapping = z.infer<typeof fieldMappingSchema>;
export type ArrayMapping = z.infer<typeof arrayMappingSchema>;

// ---------------------------------------------------------------------------
// applyMapping — deterministic application of a MappingSpec to a source value.
// Pure function; no side effects.
// ---------------------------------------------------------------------------

export function applyMapping(
  source: unknown,
  spec: MappingSpec,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const value = resolveField(source, field);
    setPath(result, field.to, value);
  }

  for (const arr of spec.arrays ?? []) {
    const sourceArray = getPath(source, arr.from);
    if (Array.isArray(sourceArray)) {
      const mapped = sourceArray.map((item) => {
        const itemResult: Record<string, unknown> = {};
        for (const f of arr.fields) {
          const v = resolveField(item, f as FieldMapping);
          setPath(itemResult, f.to, v);
        }
        return itemResult;
      });
      setPath(result, arr.to, mapped);
    } else {
      setPath(result, arr.to, []);
    }
  }

  return result;
}

function resolveField(source: unknown, field: FieldMapping): unknown {
  if (field.constant !== undefined) return field.constant;
  if (field.template !== undefined) return renderTemplate(field.template, source);

  if (field.from !== undefined) {
    let value = getPath(source, field.from);
    if (value === undefined || value === null) {
      for (const alt of field.fallbackFrom ?? []) {
        const v = getPath(source, alt);
        if (v !== undefined && v !== null) {
          value = v;
          break;
        }
      }
    }
    return value === undefined ? null : value;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path helpers — dot-notation get/set on plain objects.
// ---------------------------------------------------------------------------

export function getPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || path === '') return undefined;
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] ?? '';
    const next = current[key];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] ?? '';
  current[last] = value;
}

function renderTemplate(tpl: string, source: unknown): string {
  return tpl.replace(/\{([^}]+)\}/g, (_match, path: string) => {
    const v = getPath(source, path);
    return v === null || v === undefined ? '' : String(v);
  });
}
