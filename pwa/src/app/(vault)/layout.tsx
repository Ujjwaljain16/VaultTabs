import type { ReactNode } from 'react';
import { VaultProvider } from '@/components/vault/VaultProvider';

export default function VaultLayout({ children }: { children: ReactNode }) {
  return <VaultProvider>{children}</VaultProvider>;
}
