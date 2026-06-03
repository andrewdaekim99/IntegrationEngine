import Link from 'next/link';
import { ChevronRight, Inbox } from 'lucide-react';
import { apiGet, type EventsListResponse } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { EventStatusBadge } from '@/components/status-badge';
import { SearchBar } from '@/components/search-bar';

export const dynamic = 'force-dynamic';

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);

  let data: EventsListResponse | null = null;
  let error: string | null = null;

  try {
    data = await apiGet<EventsListResponse>(`/events?${qs.toString()}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Sync feed</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound webhooks and the events they produced.
          {data ? ` Showing ${data.events.length} of ${data.total}.` : ''}
        </p>
      </header>

      <SearchBar defaultValue={params.q} />

      {error ? (
        <ErrorState message={error} />
      ) : !data ? (
        <LoadingState />
      ) : data.events.length === 0 ? (
        <EmptyState searching={Boolean(params.q)} />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>External id</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.externalId}</TableCell>
                  <TableCell>{e.source}</TableCell>
                  <TableCell className="font-mono text-xs">{e.topic}</TableCell>
                  <TableCell>
                    <EventStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelative(e.receivedAt)}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/events/${e.id}`}
                      className="flex items-center text-muted-foreground hover:text-foreground"
                      aria-label={`View event ${e.externalId}`}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <Inbox className="h-8 w-8" />
        <p className="font-medium">
          {searching ? 'No events match that search.' : 'No events yet.'}
        </p>
        {!searching && (
          <p className="text-sm">
            Send a webhook to <code className="rounded bg-muted px-1.5 py-0.5">/webhooks/shopify/orders</code>,
            or run{' '}
            <code className="rounded bg-muted px-1.5 py-0.5">pnpm dev:send-test-webhook</code>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LoadingState() {
  return (
    <Card>
      <CardContent className="py-16 text-center text-muted-foreground">Loading…</CardContent>
    </Card>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-8 text-center text-destructive">
        <p className="font-medium">Couldn’t reach the API.</p>
        <p className="font-mono text-xs">{message}</p>
      </CardContent>
    </Card>
  );
}
