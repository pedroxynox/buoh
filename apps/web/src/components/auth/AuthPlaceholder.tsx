import { Card } from '@buoh/design-system/react';
import { PageHeader } from '../AppShell';

const COPY = {
  acceso: {
    eyebrow: 'Tu cuenta',
    title: 'Iniciar sesión',
    summary: 'Esta pantalla forma parte de la web de buoh servida por la API.',
  },
  enlace: {
    eyebrow: 'Tu cuenta',
    title: 'Enlace de alta',
    summary: 'Esta pantalla forma parte de la web de buoh servida por la API.',
  },
} as const;

/**
 * Lo que la variante del escritorio (`out`) muestra en las rutas de acceso y de enlace: una nota, sin
 * formulario ni llamadas a la API. El prototipo del escritorio es local y con datos ficticios
 * (ADR-0010), así que no inicia sesión. La compilación quita estas rutas de `out` (ADR-0019 §9);
 * esta nota solo se vería si alguna llegara a servirse.
 */
export function AuthPlaceholder({ screen }: { readonly screen: 'acceso' | 'enlace' }) {
  const copy = COPY[screen];
  return (
    <>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} summary={copy.summary} />
      <Card raised>
        <p className="b-secondary">
          El inicio de sesión y el alta de la cuenta viven en la web que sirve la API de buoh, no en
          el prototipo de escritorio.
        </p>
      </Card>
    </>
  );
}
