import { Card, PhaseLock } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { AUDIT } from '../../src/fixtures';
import { formatUtc } from '../../src/format';

export const metadata: Metadata = { title: 'Auditoría' };

export default function AuditoriaPage() {
  return (
    <>
      <PageHeader
        eyebrow="Auditoría"
        title="¿Qué pasó, cuándo y quién lo hizo?"
        summary="Un registro que solo crece: nada se edita ni se borra. Cada evento enlaza a su evidencia."
      />

      <Card title="Datos y estrategias" subtitle="Eventos recientes" headingLevel={2}>
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Cuándo</th>
                <th scope="col">Quién</th>
                <th scope="col">Evento</th>
                <th scope="col">Referencia</th>
              </tr>
            </thead>
            <tbody>
              {AUDIT.map((row) => (
                <tr key={`${row.whenUtc}-${row.reference}`}>
                  <td className="b-num w-small">{formatUtc(row.whenUtc)}</td>
                  <td>{row.actor}</td>
                  <td>{row.event}</td>
                  <td className="b-num w-small">{row.reference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <PhaseLock
        phase="4"
        title="Órdenes, respuestas y reconciliaciones"
        description="Cada intento se registrará antes de enviarse, con su clave de idempotencia y su resultado."
      />
    </>
  );
}
