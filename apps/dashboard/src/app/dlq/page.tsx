import Link from 'next/link';
import { Check, Skull } from 'lucide-react';
import { apiGet, type DlqListResponse } from '@/lib/api';
import { formatRelative } from '@/lib/format';
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
import { Badge } from '@/components/ui/badge';
import { ReplayButton } from './replay-button';

export const dynamic = 'force-dynamic';

export default async function DlqPage() {
  let data: DlqListResponse | null = null;
  let error: string | null = null;

  try {
    data = await apiGet<DlqListResponse>('/dlq?resolved=all&limit=100');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const unresolved = data?.items.filter((i) => !i.resolvedAt) ?? [];
  const resolved = data?.items.filter((i) => i.resolvedAt) ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Dead letter queue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Events that exhausted retries or hit a terminal error. Click{' '}
          <strong>Replay</strong> to re-enqueue and try again.
        </p>
      </header>

      {error ? (
        <ErrorState message={error} />
      ) : !data ? null : data.items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Unresolved ({unresolved.length})
              </CardTitle>
              <CardDescription>
                These items will keep this badge red until a replay succeeds.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {unresolved.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  Nothing here right now — clean queue.
                </p>
              ) : (
                <DlqTable items={unresolved} showReplayAction />
              )}
            </CardContent>
          </Card>

          {resolved.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base text-muted-foreground">
                  Resolved ({resolved.length})
                </CardTitle>
                <CardDescription>
                  Replayed successfully or otherwise dealt with.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <DlqTable items={resolved} />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function DlqTable({
  items,
  showReplayAction = false,
}: {
  items: DlqListResponse['items'];
  showReplayAction?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>External id</TableHead>
          <TableHead>Last error</TableHead>
          <TableHead className="w-20">Attempts</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="w-28">Status</TableHead>
          {showReplayAction && <TableHead className="w-32">Action</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} className={item.resolvedAt ? 'opacity-60' : ''}>
            <TableCell className="font-mono text-xs">
              <Link
                href={`/events/${item.event.id}`}
                className="hover:underline"
              >
                {item.event.externalId}
              </Link>
            </TableCell>
            <TableCell className="max-w-md truncate font-mono text-xs text-destructive">
              {item.lastError}
            </TableCell>
            <TableCell>{item.attempts}</TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelative(item.createdAt)}
            </TableCell>
            <TableCell>
              {item.resolvedAt ? (
                <Badge variant="success">
                  <Check className="mr-1 h-3 w-3" /> resolved
                </Badge>
              ) : (
                <Badge variant="destructive">unresolved</Badge>
              )}
            </TableCell>
            {showReplayAction && (
              <TableCell>
                {!item.resolvedAt && <ReplayButton dlqId={item.id} />}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <Skull className="h-8 w-8" />
        <p className="font-medium">No dead letters.</p>
        <p className="text-sm">
          Every event has either succeeded or is still being retried. To exercise the
          DLQ, stop the mock-erp container and send a webhook.
        </p>
      </CardContent>
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
