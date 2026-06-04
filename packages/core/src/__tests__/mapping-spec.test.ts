import { describe, it, expect } from 'vitest';
import {
  applyMapping,
  getPath,
  mappingSpecSchema,
  setPath,
  type MappingSpec,
} from '../mapping-spec.js';

describe('getPath', () => {
  const obj = {
    a: { b: { c: 42 } },
    list: [1, 2, 3],
    nullVal: null,
    emptyStr: '',
  };

  it('reads nested fields by dot path', () => {
    expect(getPath(obj, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing segments', () => {
    expect(getPath(obj, 'a.b.missing')).toBeUndefined();
    expect(getPath(obj, 'nope.no')).toBeUndefined();
  });

  it('preserves null and empty string', () => {
    expect(getPath(obj, 'nullVal')).toBeNull();
    expect(getPath(obj, 'emptyStr')).toBe('');
  });
});

describe('setPath', () => {
  it('creates intermediate objects', () => {
    const o: Record<string, unknown> = {};
    setPath(o, 'a.b.c', 7);
    expect(o).toEqual({ a: { b: { c: 7 } } });
  });

  it('overwrites non-object intermediates', () => {
    const o: Record<string, unknown> = { a: 1 };
    setPath(o, 'a.b', 7);
    expect(o).toEqual({ a: { b: 7 } });
  });
});

describe('applyMapping — direct fields', () => {
  it('copies via `from`', () => {
    const source = { id: 42, email: 'a@b.com' };
    const spec: MappingSpec = {
      fields: [
        { to: 'externalRef', from: 'id' },
        { to: 'customer.email', from: 'email' },
      ],
    };
    expect(applyMapping(source, spec)).toEqual({
      externalRef: 42,
      customer: { email: 'a@b.com' },
    });
  });

  it('renders templates with {path} placeholders', () => {
    const source = { id: 42, customer: { first_name: 'Test', last_name: 'Buyer' } };
    const spec: MappingSpec = {
      fields: [
        { to: 'externalRef', template: 'shopify-{id}' },
        { to: 'customer.name', template: '{customer.first_name} {customer.last_name}' },
      ],
    };
    expect(applyMapping(source, spec)).toEqual({
      externalRef: 'shopify-42',
      customer: { name: 'Test Buyer' },
    });
  });

  it('emits literal constants', () => {
    const spec: MappingSpec = {
      fields: [
        { to: 'source', constant: 'shopify' },
        { to: 'isLive', constant: true },
      ],
    };
    expect(applyMapping({}, spec)).toEqual({ source: 'shopify', isLive: true });
  });

  it('falls back via fallbackFrom chain', () => {
    const source = { email: null, customer: { email: 'fallback@x.com' } };
    const spec: MappingSpec = {
      fields: [
        { to: 'email', from: 'email', fallbackFrom: ['customer.email'] },
      ],
    };
    expect(applyMapping(source, spec)).toEqual({ email: 'fallback@x.com' });
  });

  it('sets null when nothing resolves', () => {
    const spec: MappingSpec = {
      fields: [{ to: 'missing', from: 'nope.nada' }],
    };
    expect(applyMapping({}, spec)).toEqual({ missing: null });
  });
});

describe('applyMapping — arrays', () => {
  it('iterates a source array and applies per-item field mappings', () => {
    const source = {
      line_items: [
        { id: 1, title: 'Tee', quantity: 1, price: '29.50', sku: 'TEE-001' },
        { id: 2, title: 'Sticker', quantity: 3, price: '4.00', sku: 'STK-003' },
      ],
    };
    const spec: MappingSpec = {
      fields: [],
      arrays: [
        {
          to: 'items',
          from: 'line_items',
          fields: [
            { to: 'sku', from: 'sku' },
            { to: 'quantity', from: 'quantity' },
            { to: 'price', from: 'price' },
          ],
        },
      ],
    };
    expect(applyMapping(source, spec)).toEqual({
      items: [
        { sku: 'TEE-001', quantity: 1, price: '29.50' },
        { sku: 'STK-003', quantity: 3, price: '4.00' },
      ],
    });
  });

  it('emits an empty array when the source path is missing', () => {
    const spec: MappingSpec = {
      fields: [],
      arrays: [{ to: 'items', from: 'line_items', fields: [{ to: 'x', from: 'y' }] }],
    };
    expect(applyMapping({}, spec)).toEqual({ items: [] });
  });
});

describe('mappingSpecSchema', () => {
  it('accepts a valid spec', () => {
    const r = mappingSpecSchema.safeParse({
      fields: [{ to: 'a', from: 'b' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a field with both `from` and `constant`', () => {
    const r = mappingSpecSchema.safeParse({
      fields: [{ to: 'a', from: 'b', constant: 'c' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a field with none of `from`/`template`/`constant`', () => {
    const r = mappingSpecSchema.safeParse({
      fields: [{ to: 'a' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('end-to-end: Shopify order → MockErp shape', () => {
  it('produces the same shape the hardcoded mapper does', () => {
    const order = {
      id: 5912345678901,
      email: 'buyer@example.com',
      total_price: '29.50',
      currency: 'USD',
      customer: { first_name: 'Test', last_name: 'Buyer', email: 'buyer@example.com' },
      line_items: [{ id: 1, title: 'Tee', quantity: 1, price: '29.50', sku: 'TEE-001' }],
    };
    const spec: MappingSpec = {
      fields: [
        { to: 'externalRef', template: 'shopify-{id}' },
        { to: 'customer.email', from: 'email', fallbackFrom: ['customer.email'] },
        { to: 'customer.name', template: '{customer.first_name} {customer.last_name}' },
        { to: 'totalAmount', from: 'total_price' },
        { to: 'currency', from: 'currency' },
      ],
      arrays: [
        {
          to: 'items',
          from: 'line_items',
          fields: [
            { to: 'sku', from: 'sku' },
            { to: 'quantity', from: 'quantity' },
            { to: 'price', from: 'price' },
          ],
        },
      ],
    };
    expect(applyMapping(order, spec)).toEqual({
      externalRef: 'shopify-5912345678901',
      customer: {
        email: 'buyer@example.com',
        name: 'Test Buyer',
      },
      totalAmount: '29.50',
      currency: 'USD',
      items: [{ sku: 'TEE-001', quantity: 1, price: '29.50' }],
    });
  });
});
