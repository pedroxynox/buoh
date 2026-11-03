import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { AuthPlaceholder } from '../../src/components/auth/AuthPlaceholder';

export const metadata: Metadata = { title: 'Iniciar sesión' };

// La variante de la API trae el formulario de inicio de sesión; la del escritorio, solo una nota.
// La variable de compilación, que Next inlinea, deja que el empaquetador quite del escritorio el
// formulario y todo lo que llama a la API (ADR-0019 §9; `F2-UI-001`).
function AccesoDesktop() {
  return <AuthPlaceholder screen="acceso" />;
}

const Acceso =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() =>
        import('../../src/components/auth/AccesoForm').then((module) => module.AccesoForm),
      )
    : AccesoDesktop;

export default function AccesoPage() {
  return <Acceso />;
}
