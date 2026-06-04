import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { applyMapping } from '@integr8/core';
import { MappingProposer, type MappingProposal } from '../mapping-proposer.js';

/** Canned proposal Claude would plausibly return for the Shopify → MockErp case. */
const proposalFixture: MappingProposal = {
  fields: [
    {
      to: 'externalRef',
      template: 'shopify-{id}',
      rationale: 'Prefix the source order id so downstream systems can tell where it came from.',
      confidence: 'high',
    },
    {
      to: 'customer.email',
      from: 'email',
      fallbackFrom: ['customer.email'],
      rationale: 'Shopify duplicates the buyer email at the order root; the customer block is a fallback.',
      confidence: 'high',
    },
    {
      to: 'customer.name',
      template: '{customer.first_name} {customer.last_name}',
      rationale: 'Mock ERP wants a single display name; concatenate first + last.',
      confidence: 'medium',
    },
    {
      to: 'totalAmount',
      from: 'total_price',
      rationale: 'Shopify uses snake_case money fields.',
      confidence: 'high',
    },
    {
      to: 'currency',
      from: 'currency',
      rationale: 'Direct copy — same key, same shape.',
      confidence: 'high',
    },
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
  notes: 'High confidence overall — the destination shape mirrors common ERP fields.',
};

const sampleOrder = {
  id: 5912345678901,
  email: 'buyer@example.com',
  total_price: '29.50',
  currency: 'USD',
  customer: { first_name: 'Test', last_name: 'Buyer', email: 'buyer@example.com' },
  line_items: [{ id: 1, sku: 'TEE-001', quantity: 1, price: '29.50' }],
};

const sampleMockErpShape = {
  externalRef: 'shopify-1',
  customer: { email: 'b@example.com', name: 'Buyer Name' },
  items: [{ sku: 'X', quantity: 1, price: '10.00' }],
  totalAmount: '10.00',
  currency: 'USD',
};

function makeStubClient(text: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
      }),
    },
  } as unknown as Anthropic;
}

describe('MappingProposer', () => {
  it('parses a clean JSON response into a MappingProposal', async () => {
    const stub = makeStubClient(JSON.stringify(proposalFixture, null, 2));
    const proposer = new MappingProposer({ apiKey: 'test', client: stub });

    const result = await proposer.propose({
      sourceSystem: 'shopify',
      destinationSystem: 'mock-erp',
      sourceSample: sampleOrder,
      destinationSample: sampleMockErpShape,
    });

    expect(result.fields).toHaveLength(5);
    expect(result.fields[0]?.to).toBe('externalRef');
    expect(result.fields[0]?.template).toBe('shopify-{id}');
    expect(result.arrays).toHaveLength(1);
    expect(result.notes).toMatch(/high confidence/i);
  });

  it('strips ```json … ``` fences if the model emits them', async () => {
    const stub = makeStubClient('```json\n' + JSON.stringify(proposalFixture) + '\n```');
    const proposer = new MappingProposer({ apiKey: 'test', client: stub });
    const result = await proposer.propose({
      sourceSystem: 'shopify',
      destinationSystem: 'mock-erp',
      sourceSample: sampleOrder,
      destinationSample: sampleMockErpShape,
    });
    expect(result.fields).toHaveLength(5);
  });

  it('throws when the model returns non-JSON', async () => {
    const stub = makeStubClient('Sure! Here is the mapping you asked for.');
    const proposer = new MappingProposer({ apiKey: 'test', client: stub });
    await expect(
      proposer.propose({
        sourceSystem: 'shopify',
        destinationSystem: 'mock-erp',
        sourceSample: sampleOrder,
        destinationSample: sampleMockErpShape,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws when the JSON fails MappingSpec validation', async () => {
    // Both `from` and `constant` on the same field — refinement should reject.
    const invalid = {
      fields: [{ to: 'a', from: 'b', constant: 'c' }],
    };
    const stub = makeStubClient(JSON.stringify(invalid));
    const proposer = new MappingProposer({ apiKey: 'test', client: stub });
    await expect(
      proposer.propose({
        sourceSystem: 'shopify',
        destinationSystem: 'mock-erp',
        sourceSample: sampleOrder,
        destinationSample: sampleMockErpShape,
      }),
    ).rejects.toThrow(/schema validation/);
  });

  it('sends the configured model + system block with cache_control', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(proposalFixture) }],
    });
    const stub = { messages: { create: createSpy } } as unknown as Anthropic;
    const proposer = new MappingProposer({
      apiKey: 'test',
      client: stub,
      model: 'claude-sonnet-4-6',
    });
    await proposer.propose({
      sourceSystem: 'shopify',
      destinationSystem: 'mock-erp',
      sourceSample: sampleOrder,
      destinationSample: sampleMockErpShape,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0]?.[0];
    expect(arg.model).toBe('claude-sonnet-4-6');
    expect(Array.isArray(arg.system)).toBe(true);
    expect(arg.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(arg.system[0].text).toMatch(/MappingSpec/);
  });

  it('round-trips: proposal applied to a real Shopify order yields the expected MockErp shape', async () => {
    const stub = makeStubClient(JSON.stringify(proposalFixture));
    const proposer = new MappingProposer({ apiKey: 'test', client: stub });
    const proposal = await proposer.propose({
      sourceSystem: 'shopify',
      destinationSystem: 'mock-erp',
      sourceSample: sampleOrder,
      destinationSample: sampleMockErpShape,
    });

    const mapped = applyMapping(sampleOrder, proposal);
    expect(mapped).toEqual({
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
