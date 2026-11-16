'use client';

import { useEffect } from 'react';

/** Registers /sw.js in production; in development removes any stale worker so HMR is not cached. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then(regs => regs.forEach(r => void r.unregister()))
        .catch(() => {});
      return;
    }
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      /* offline support is optional */
    });
  }, []);
  return null;
}
