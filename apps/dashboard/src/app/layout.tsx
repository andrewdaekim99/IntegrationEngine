import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'integr8',
  description: 'Integration engine dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
