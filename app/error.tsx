'use client';

import Link from 'next/link';
import { Button } from '../client/ui';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="boot-error"><h1>This page needs another try.</h1><p>Your workspace could not load this page. Retry or return to the overview.</p><div className="page-actions"><Button onClick={reset}>Try again</Button><Link className="button secondary" href="/overview">Open overview</Link></div></main>;
}
