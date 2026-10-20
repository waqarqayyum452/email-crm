import Link from 'next/link';
import { Waves } from 'lucide-react';

export default function NotFound() {
  return <main className="boot-error"><div className="brand-icon"><Waves /></div><h1>This page isn’t in your workspace.</h1><p>Check the address or return to your agency overview.</p><Link className="button primary" href="/overview">Open overview</Link></main>;
}
