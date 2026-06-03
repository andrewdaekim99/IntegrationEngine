import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { apiGet, type IngestedEventDetail } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EventStatusBadge, SyncRunOutcomeBadge } from '@/components/status-badge';

export const dynamic = 'force-dynamic';

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let event: IngestedEventDetail | null = null;
  try {
    const res = await apiGet<{ event: IngestedEventDetail }>(`/events/${id}`);
    event = res.event;
  } catch (e) {
    if (e instanceof Error && /404/.test(e.message)) {
      notFound();
    }
    throw e;
  }
  if (!event) notFound();

  return (
    <div className="space-y-6">
      <Link
        href="/events"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to sync feed
      </Link>

      <header>
        <p className="font-mono text-xs text-muted-foreground">{event.id}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          {event.source} · <span className="font-mono">{event.externalId}</span>
        </h1>
        <div className="mt-3 flex items-center gap-3">
          <EventStatusBadge status={event.status} />
          <span className="text-sm text-muted-foreground">{event.topic}</span>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Received">{formatDateTime(event.receivedAt)}</Field>
          <Field label="Processed">{formatDateTime(event.processedAt)}</Field>
          <Field label="Signature verified">{event.signatureVerified ? 'yes' : 'no'}</Field>
          <Field label="Topic">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{event.topic}</code>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sync runs</CardTitle>
          <CardDescription>
            {event.syncRuns.length} attempt{event.syncRuns.length === 1 ? '' : 's'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {event.syncRuns.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No attempts yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {event.syncRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-mono">{run.attempt}</TableCell>
                    <TableCell>{run.destination}</TableCell>
                    <TableCell>
                      <SyncRunOutcomeBadge outcome={run.outcome} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(run.startedAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs text-destructive">
                      {run.errorMessage ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {event.deadLetterItem && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dead letter item</CardTitle>
            <CardDescription>
              {event.deadLetterItem.resolvedAt
                ? `Resolved ${formatDateTime(event.deadLetterItem.resolvedAt)}`
                : `Unresolved · ${event.deadLetterItem.attempts} attempts`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Field label="Last error">
              <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
                {event.deadLetterItem.lastError}
              </pre>
            </Field>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Raw payload</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-96 overflow-auto rounded bg-muted p-4 font-mono text-xs">
            {JSON.stringify(event.rawPayload, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}
