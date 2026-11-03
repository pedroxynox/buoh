import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { AuthPlaceholder } from '../../src/components/auth/AuthPlaceholder';

export const metadata: Metadata = { title: 'Enlace de alta' };

// Igual que la ruta de acceso: la variante de la API trae el flujo del enlace (con su QR), y la del
// escritorio solo una nota. El empaquetador quita del escritorio todo lo que llama a la API.
function EnlaceDesktop() {
  return <AuthPlaceholder screen="enlace" />;
}

const Enlace =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() =>
        import('../../src/components/auth/EnlaceForm').then((module) => module.EnlaceForm),
      )
    : EnlaceDesktop;

export default function EnlacePage() {
  return <Enlace />;
}
