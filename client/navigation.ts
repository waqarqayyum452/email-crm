'use client';

/** Map only known dashboard bookmarks; never accept arbitrary navigation targets. */
export function legacyDashboardPath(hash: string): string | null {
  const route = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return /^(overview|prospects|campaigns|templates|inbox|pipeline|analytics|suppressions|settings|health)(\/[a-zA-Z0-9_-]+)?$/.test(route) ? `/${route}` : null;
}
