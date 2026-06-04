import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Studio } from './studio';

const SHOPIFY_SAMPLE = JSON.stringify(
  {
    id: 5912345678901,
    email: 'buyer@example.com',
    created_at: '2026-06-03T14:00:00-04:00',
    total_price: '42.50',
    currency: 'USD',
    customer: {
      id: 7012345678901,
      email: 'buyer@example.com',
      first_name: 'Test',
      last_name: 'Buyer',
    },
    line_items: [
      { id: 14012345678901, title: 'Integr8 Tee', quantity: 1, price: '29.50', sku: 'TEE-001' },
      { id: 14012345678902, title: 'Sticker pack', quantity: 3, price: '4.00', sku: 'STK-003' },
    ],
  },
  null,
  2,
);

const MOCK_ERP_SAMPLE = JSON.stringify(
  {
    externalRef: 'shopify-1234',
    customer: { email: 'someone@example.com', name: 'Full Name' },
    items: [{ sku: 'TEE-001', quantity: 1, price: '29.50' }],
    totalAmount: '29.50',
    currency: 'USD',
  },
  null,
  2,
);

export default function NewMappingPage() {
  return (
    <div className="space-y-6">
      <Link
        href="/mappings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to mappings
      </Link>

      <header>
        <h1 className="text-3xl font-bold tracking-tight">Mapping studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a sample payload from the source and destination, let Claude
          propose a mapping, then review and approve.
        </p>
      </header>

      <Studio
        defaultSource={SHOPIFY_SAMPLE}
        defaultDestination={MOCK_ERP_SAMPLE}
        defaultSourceSystem="shopify"
        defaultDestinationSystem="mock-erp"
      />
    </div>
  );
}
