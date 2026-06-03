'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

const DEBOUNCE_MS = 250;

/**
 * Live-search input. Pushes a new URL ~250ms after the last keystroke; an
 * empty value drops the `q` param entirely, restoring the "all events" view.
 * No Enter required, no submit button.
 */
export function SearchBar({ defaultValue = '' }: { defaultValue?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(defaultValue);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Don't push on mount — would re-fetch the same data we just rendered.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const trimmed = value.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, router, pathname]);

  return (
    <div className="relative max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder="Search by external id…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="pl-10"
        aria-label="Search events by external id"
      />
    </div>
  );
}
