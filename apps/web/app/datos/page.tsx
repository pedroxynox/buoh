import { Badge, Card, SeverityTag } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import {
  DATASETS,
  formatUtc,
  INCIDENT_LABELS,
  INCIDENT_STATUS,
  INCIDENTS,
} from '@buoh/prototype-data';

/**
 * Datos (concepto de interfaz §3). Los datasets e incidencias son ficticios: los datasets reales de
 * Fase 1 no llegan a ningún cliente y hoy solo se comprueban con `pnpm run data:replay`.
 */
export const metadata: Metadata = { title: 'Datos' };

export default function DatosPage() {
  return (
    <>
      <PageHeader
        eyebrow="Datos"
        title="¿Puedo confiar en estos datos?"
        summary="Cada lote publicado tiene un identificador que permite reconstruirlo igual. Las incidencias de calidad nunca se borran; las condiciones, como un hueco o una conexión perdida, se abren y se resuelven con eventos nuevos."
      />

      <Card title="Datasets publicados" subtitle="Inmutables y reproducibles" headingLevel={2}>
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Identificador</th>
                <th scope="col">Fuente</th>
                <th scope="col">Período</th>
                <th scope="col">Ticks</th>
                <th scope="col">Incidencias</th>
                <th scope="col">Reglas</th>
                <th scope="col">Verificación</th>
              </tr>
            </thead>
            <tbody>
              {DATASETS.map((dataset) => (
                <tr key={dataset.id}>
                  <td className="b-num">{dataset.id}</td>
                  <td>{dataset.source}</td>
                  <td>{dataset.period}</td>
                  <td className="b-num">{dataset.ticks}</td>
                  <td className="b-num">{String(dataset.incidents)}</td>
                  <td className="b-num">{dataset.rules}</td>
                  <td>
                    {dataset.verified ? (
                      <Badge tone="aurora" icon="check">
                        Reproducido
                      </Badge>
                    ) : (
                      <Badge tone="naranja" icon="alertTriangle">
                        Pendiente
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Incidencias de calidad"
        subtitle="Abiertas y resueltas, con su evidencia"
        headingLevel={2}
      >
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Severidad</th>
                <th scope="col">Símbolo</th>
                <th scope="col">Fuente</th>
                <th scope="col">Cuándo</th>
                <th scope="col">Estado</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {INCIDENTS.map((incident) => (
                <tr key={`${incident.type}-${incident.whenUtc}`}>
                  <td>{INCIDENT_LABELS[incident.type]}</td>
                  <td>
                    <SeverityTag severity={incident.severity} />
                  </td>
                  <td className="b-num">{incident.symbol}</td>
                  <td>{incident.source}</td>
                  <td className="b-num w-small">{formatUtc(incident.whenUtc)}</td>
                  <td>
                    <Badge
                      tone={INCIDENT_STATUS[incident.status].tone}
                      icon={INCIDENT_STATUS[incident.status].icon}
                    >
                      {INCIDENT_STATUS[incident.status].label}
                    </Badge>
                  </td>
                  <td className="b-secondary w-small">{incident.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="w-grid w-grid--2">
        <Card title="Reproducir un dataset" subtitle="Cómo se comprueba">
          <ol className="b-secondary w-small w-stack">
            <li>Se leen los frames crudos guardados, sin contactar a la fuente.</li>
            <li>
              Se vuelven a calcular ticks, incidencias y condiciones con las mismas versiones.
            </li>
            <li>El identificador recalculado debe ser idéntico al publicado.</li>
          </ol>
        </Card>
        <Card title="Qué nunca pasa" subtitle="Reglas de los datos">
          <ul className="b-secondary w-small w-stack">
            <li>Un dato crudo no se reescribe.</li>
            <li>Un hueco no se rellena ni se suaviza.</li>
            <li>Una incidencia no desaparece al resolverse: queda su historia.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
