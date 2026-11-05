'use client';

import { Badge, HealthBadge } from '@buoh/design-system/react';
import { ageText, healthView, type HealthView } from './salud';
import { useDataHealth } from './store';

/**
 * La insignia de salud de una vista (concepto de interfaz §4 y §10): uno de los seis estados del
 * contrato con su icono y su texto, o, cuando la web no lo sabe, una insignia neutra que dice por qué,
 * sin tono de estado. Una observación antigua suma su marca.
 */
export function SaludBadgeView({ view }: { readonly view: HealthView }) {
  return (
    <>
      {view.badge.kind === 'state' ? (
        <HealthBadge health={view.badge.health} />
      ) : (
        <Badge icon={view.badge.icon} title={`Salud: ${view.badge.label}. ${view.summary}`}>
          <span className="b-visually-hidden">Salud: </span>
          {view.badge.label}
        </Badge>
      )}
      {view.observation?.stale === true ? (
        <Badge
          icon="clock"
          title={`Salud: observación antigua, de hace ${ageText(view.observation.ageMs)}.`}
        >
          <span className="b-visually-hidden">Salud: observación </span>
          Antigua
        </Badge>
      ) : null}
    </>
  );
}

/** La insignia de la barra superior con la salud real, la misma lectura que el Observatorio. */
export function SaludBadge() {
  return <SaludBadgeView view={healthView(useDataHealth())} />;
}
