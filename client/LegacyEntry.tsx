'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Waves } from 'lucide-react';
import { legacyDashboardPath } from './navigation';
import { Loading } from './ui';

export default function LegacyEntry() {
  const router = useRouter();
  useEffect(() => { router.replace(legacyDashboardPath(window.location.hash) || '/overview'); }, [router]);
  return <div className="boot"><Waves size={34} /><Loading /></div>;
}
