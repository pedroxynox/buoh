import '@fontsource-variable/sen';
import '@fontsource-variable/jetbrains-mono';
import '@buoh/design-system/buoh.css';
import './site.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { TAGLINE } from '../src/content';
import { SiteFrame } from '../src/Frame';

export const metadata: Metadata = {
  title: { default: `buoh · ${TAGLINE}`, template: '%s · buoh' },
  description:
    'buoh es un sistema en desarrollo para investigar estrategias de trading, emitir señales trazables y, solo si se aprueba, ejecutar con control de riesgo. No promete ganancias.',
  // No se publica hasta que el propietario decida dominio y alojamiento (ADR-0008 §3).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#080F1B',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es" data-theme="noche">
      <body>
        <SiteFrame>{children}</SiteFrame>
      </body>
    </html>
  );
}
