import { Badge } from '@/components/ui/badge';
import type { EventStatus, SyncRunOutcome } from '@/lib/api';

const eventVariant: Record<EventStatus, React.ComponentProps<typeof Badge>['variant']> = {
  RECEIVED: 'secondary',
  PROCESSING: 'info',
  RETRYING: 'warning',
  SUCCEEDED: 'success',
  DEDUPED: 'outline',
  DEAD_LETTERED: 'destructive',
};

const runVariant: Record<SyncRunOutcome, React.ComponentProps<typeof Badge>['variant']> = {
  PENDING: 'secondary',
  SUCCEEDED: 'success',
  RETRYABLE_FAILURE: 'warning',
  TERMINAL_FAILURE: 'destructive',
  DEDUPED: 'outline',
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge variant={eventVariant[status]}>{status.toLowerCase().replace('_', ' ')}</Badge>;
}

export function SyncRunOutcomeBadge({ outcome }: { outcome: SyncRunOutcome }) {
  return (
    <Badge variant={runVariant[outcome]}>{outcome.toLowerCase().replace(/_/g, ' ')}</Badge>
  );
}
