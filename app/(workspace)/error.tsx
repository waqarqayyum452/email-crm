'use client';

import { ErrorBox } from '../../client/ui';

export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorBox error="This page could not load. Your session and workspace navigation are still available." retry={reset} />;
}
