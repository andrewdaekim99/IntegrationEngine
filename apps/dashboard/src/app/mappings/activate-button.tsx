'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { activateMapping } from './actions';

export function ActivateButton({ mappingId }: { mappingId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const r = await activateMapping(mappingId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={onClick} disabled={pending}>
        {pending ? 'Activating…' : 'Activate'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
