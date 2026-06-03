'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Skull } from 'lucide-react';
import { cn } from '@/lib/utils';

const links = [
  { href: '/events', label: 'Sync feed', icon: Activity },
  { href: '/dlq', label: 'Dead letter queue', icon: Skull },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="space-y-1 px-3">
      {links.map(({ href, label, icon: Icon }) => {
        const isActive = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
