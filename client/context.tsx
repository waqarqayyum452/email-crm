'use client';

import { createContext, useContext } from 'react';
import type { Row, Session } from './api';
export interface Workspace {
  session: Session; revision: number; settings: Row; accounts: Row[]; stages: Row[]; users: Row[];
  can: (permission: string) => boolean;
  refresh: () => void; notify: (message: string, error?: boolean) => void;
  act: <T = any>(path: string, options: RequestInit, success?: string) => Promise<T>;
}
export const WorkspaceContext = createContext<Workspace>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);
