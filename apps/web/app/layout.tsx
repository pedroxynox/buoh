import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import '@buoh/design-system/buoh.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '../src/components/AppShell';

export const metadata: Metadata = {
  title: { default: 'buoh · prototipo', template: '%s · buoh · prototipo' },
  description: 'Prototipo visual de buoh con datos ficticios. No es un producto en funcionamiento.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0A101C',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es" data-theme="noche">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
