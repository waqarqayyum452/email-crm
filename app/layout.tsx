import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../client/styles.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'San Diego Website Experts · Email CRM',
  description: 'The private email and relationship workspace for San Diego Website Experts.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#203549' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
