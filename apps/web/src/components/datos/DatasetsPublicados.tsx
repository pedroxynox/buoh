import type { DataDataset, DataDatasets } from '@buoh/contracts';
import { Badge, Callout, Card } from '@buoh/design-system/react';
import type { IconName, Tone } from '@buoh/design-system';
import { formatUtc } from '@buoh/prototype-data';
import Link from 'next/link';
import { datasetEnd, datasetIncidents, datasetPeriod, verificationText } from './datasets';
import { DATA_DATASETS_LIMIT } from './respuesta';

/**
 * Lo que se sabe de los datasets: leyendo, un fallo con su texto fijo, o la respuesta, con la hora
 * UTC en que llegó.
 */
export type DatasetsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly unauthenticated: boolean }
  | { readonly kind: 'ready'; readonly data: DataDatasets; readonly readAtUtc: string };

type Verification = DataDataset['verifications']['verify_only'];

/** El tono y el icono de cada resultado de la verificación: siempre con su texto. */
function verificationLook(verification: Verification): { tone: Tone; icon: IconName } {
  if (verification === null) {
    return { tone: 'niebla', icon: 'clock' };
  }
  switch (verification.status) {
    case 'passed':
      return { tone: 'aurora', icon: 'check' };
    case 'failed':
      return { tone: 'rojo', icon: 'xOctagon' };
    case 'incomplete':
      return { tone: 'naranja', icon: 'alertTriangle' };
  }
}

/** El último resultado de un modo y, si lo hay, su hora, en texto a la vista. */
function VerificationResult({
  label,
  verification,
}: {
  readonly label: string;
  readonly verification: Verification;
}) {
  const { icon, tone } = verificationLook(verification);
  return (
    <div>
      <Badge tone={tone} icon={icon}>
        {`${label}: ${verificationText(verification)}`}
      </Badge>
      {verification === null ? null : (
        <div className="b-secondary b-num w-small">{formatUtc(verification.verified_at_utc)}</div>
      )}
    </div>
  );
}

/**
 * Los metadatos de la lista (concepto de interfaz §1): la fuente, los símbolos, las reglas, el
 * intervalo, cuánto se guardan y la frescura, la fecha y la hora de la lectura, sin refresco.
 */
function metadataNote(data: DataDatasets, readAtUtc: string | null): string {
  const symbols = [...new Set(data.datasets.flatMap((dataset) => dataset.symbols))].sort();
  const rules = [...new Set(data.datasets.map((dataset) => dataset.quality_rule_version))].sort();
  const base = 'Captura de Deriv. Las horas son UTC.';
  const of =
    data.datasets.length === 0
      ? ''
      : ` Símbolos: ${symbols.join(', ')}; reglas ${rules.join(', ')}.`;
  const interval =
    ' Cada dataset tiene unas 6 horas de captura, cortadas cerca de las 00:00, 06:00, 12:00 o 18:00 UTC, y uno nuevo suele llegar poco después de esas horas.' +
    ' Los datasets no vencen: siguen aunque su log ya no exista.';
  const cut = data.truncated
    ? ` Se muestran los ${String(DATA_DATASETS_LIMIT)} más recientes: hay otros más viejos.`
    : '';
  const read =
    readAtUtc === null ? '' : ` Leído el ${formatUtc(readAtUtc)}; la página no se actualiza sola.`;
  return `${base}${of}${interval}${cut}${read}`;
}

/**
 * Los datasets publicados en la sección Datos (concepto de interfaz §14; ADR-0020 §10): uno por fila,
 * del más nuevo al más viejo, con su publicación, su período, su log y sus segmentos, sus ticks, sus
 * incidencias, cómo terminó y la última verificación de cada modo, sin controles para cambiar nada.
 * Recibe el estado y no pide nada.
 */
export function DatasetsPublicadosView({ state }: { readonly state: DatasetsState }) {
  return (
    <Card title="Datasets publicados" subtitle="Inmutables y reproducibles" headingLevel={2}>
      {state.kind === 'loading' ? (
        <p className="b-secondary">Cargando los datasets publicados…</p>
      ) : state.kind === 'error' ? (
        <Callout tone="rojo" icon="alertTriangle" title="No se pudieron cargar">
          {state.message}
          {state.unauthenticated ? (
            <p>
              <Link className="w-link" href="/acceso">
                Iniciar sesión
              </Link>
            </p>
          ) : null}
        </Callout>
      ) : state.data.datasets.length === 0 ? (
        <p className="b-secondary">
          Todavía no hay datasets publicados: buoh publica uno con cada 6 horas de captura. Vuelve a
          abrir la página más tarde.
        </p>
      ) : (
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Publicado</th>
                <th scope="col">Período</th>
                <th scope="col">Origen</th>
                <th scope="col">Ticks</th>
                <th scope="col">Incidencias</th>
                <th scope="col">Final</th>
                <th scope="col">Verificación</th>
                <th scope="col">Identificador</th>
              </tr>
            </thead>
            <tbody>
              {state.data.datasets.map((dataset) => (
                <tr key={dataset.dataset_id}>
                  <td className="b-num w-small">{formatUtc(dataset.published_at_utc)}</td>
                  <td className="b-num w-small">{datasetPeriod(dataset)}</td>
                  <td className="w-small">
                    {`Log ${String(dataset.log)} · segmentos ${String(dataset.first_segment)}–${String(dataset.last_segment)}`}
                  </td>
                  <td className="b-num">{dataset.normalized_tick_count}</td>
                  <td className="w-small">{datasetIncidents(dataset)}</td>
                  <td>
                    <Badge
                      tone={dataset.clean ? 'aurora' : 'naranja'}
                      icon={dataset.clean ? 'check' : 'alertTriangle'}
                    >
                      {datasetEnd(dataset)}
                    </Badge>
                  </td>
                  <td>
                    <div className="w-stack">
                      <VerificationResult
                        label="Comprobación"
                        verification={dataset.verifications.verify_only}
                      />
                      <VerificationResult
                        label="Recálculo"
                        verification={dataset.verifications.recompute}
                      />
                    </div>
                  </td>
                  <td className="b-num w-small">{`${dataset.dataset_id.slice(0, 19)}…`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="b-secondary w-small">
        {state.kind === 'ready'
          ? metadataNote(state.data, state.readAtUtc)
          : metadataNote({ datasets: [], truncated: false }, null)}
      </p>
    </Card>
  );
}
