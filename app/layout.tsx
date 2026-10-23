import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import '../client/styles.css';
import '../client/theme.css';
import '../client/brand.css';

const geist = localFont({
  src: './fonts/Geist-Variable.woff2',
  variable: '--font-geist',
  weight: '100 900',
  display: 'swap',
});
const display = localFont({
  src: [
    { path: './fonts/BagossStandard-Medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/BagossStandard-SemiBold.woff2', weight: '600', style: 'normal' },
    { path: './fonts/BagossStandard-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-brand-display',
  display: 'swap',
});

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'San Diego Website Experts · Email CRM',
  description: 'The private email and relationship workspace for San Diego Website Experts.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#3863ff' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={`${geist.variable} ${display.variable}`}><body>{children}</body></html>;
}
