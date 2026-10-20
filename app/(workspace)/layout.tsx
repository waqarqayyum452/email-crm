import type { ReactNode } from 'react';
import App from '../../client/App';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <App>{children}</App>;
}
