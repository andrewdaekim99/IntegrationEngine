'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { replayDlqItem } from './actions';

export function ReplayButton({ dlqId }: { dlqId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await replayDlqItem(dlqId);
      if (result.ok) {
        // Small delay to let the worker make progress before refresh.
        setTimeout(() => router.refresh(), 500);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="default"
        onClick={onClick}
        disabled={pending}
        aria-label="Replay this dead-letter item"
      >
        <RotateCw className={cn('mr-1.5 h-3.5 w-3.5', pending && 'animate-spin')} />
        {pending ? 'Replaying…' : 'Replay'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
