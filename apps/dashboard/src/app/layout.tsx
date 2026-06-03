import './globals.css';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';

export const metadata = {
  title: 'integr8',
  description: 'Self-hostable integration engine — sync feed, DLQ, mapping studio.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <div className="flex min-h-screen">
          <aside className="w-60 shrink-0 border-r bg-card">
            <div className="px-6 py-5">
              <h1 className="text-xl font-bold tracking-tight">integr8</h1>
              <p className="mt-1 text-xs text-muted-foreground">integration engine</p>
            </div>
            <Nav />
          </aside>
          <main className="flex-1 px-10 py-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
