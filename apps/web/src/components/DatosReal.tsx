'use client';

import { Card } from '@buoh/design-system/react';
import { useEffect, useState } from 'react';
import { PageHeader } from './AppShell';
import { api, ApiCallError, describeFailure } from './auth/api';
import { DatasetsPublicadosView, type DatasetsState } from './datos/DatasetsPublicados';

/**
 * Datos de la web servida por la API (concepto de interfaz §14; ADR-0020 §10): pide al abrir la página
 * los datasets publicados, del más nuevo al más viejo, con su verificación, y guarda la hora de la
 * lectura, porque no se actualiza sola. Las incidencias de cada dataset se cuentan por tipo y
 * gravedad: ninguna pantalla las muestra todavía una por una. Sin sesión, invita a iniciarla.
 */
export function DatosReal() {
  const [state, setState] = useState<DatasetsState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    api
      .dataDatasets()
      .then((data) => {
        if (active) setState({ kind: 'ready', data, readAtUtc: new Date().toISOString() });
      })
      .catch((caught: unknown) => {
        if (active) {
          setState({
            kind: 'error',
            message:
              caught instanceof ApiCallError
                ? describeFailure(caught.failure)
                : 'No se pudieron cargar los datasets publicados.',
            unauthenticated:
              caught instanceof ApiCallError && caught.failure.code === 'unauthenticated',
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Datos"
        title="¿Puedo confiar en estos datos?"
        summary="Cada dataset publicado tiene un identificador que permite reconstruirlo igual, y buoh lo comprueba en dos modos poco después de publicarlo. Los datasets no vencen."
      />

      <DatasetsPublicadosView state={state} />

      <div className="w-grid w-grid--2">
        <Card title="Cómo se verifica" subtitle="Dos modos, sin contactar a la fuente">
          <ol className="b-secondary w-small w-stack">
            <li>
              Comprobación: se leen sus objetos y se comprueba cada hash, sin recalcular nada.
            </li>
            <li>
              Recálculo: se vuelven a derivar los ticks, las incidencias y las condiciones de sus
              frames crudos, con las mismas versiones.
            </li>
            <li>En los dos, el identificador tiene que salir idéntico al publicado.</li>
          </ol>
        </Card>
        <Card title="Qué nunca pasa" subtitle="Reglas de los datos">
          <ul className="b-secondary w-small w-stack">
            <li>Un dato crudo no se reescribe.</li>
            <li>Un hueco no se rellena ni se suaviza.</li>
            <li>
              Una incidencia no desaparece al resolverse: queda en su dataset, que no vence. Aquí se
              cuentan por tipo; la lista de cada una todavía no está en la web.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
