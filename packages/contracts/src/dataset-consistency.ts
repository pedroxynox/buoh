import { ContractContextError, type OperationalConditionEvent } from './conditions.js';
import { type DataQualityIncident } from './data-quality.js';
import { type DatasetManifestCore } from './dataset.js';
import { type MarketTick } from './market-tick.js';
import { type SourceEvent } from './source-events.js';

export interface DatasetConsistencyInput {
  readonly conditions: readonly OperationalConditionEvent[];
  readonly core: DatasetManifestCore;
  readonly incidents: readonly DataQualityIncident[];
  /** Source events de todos los segmentos, en orden de observación. */
  readonly sourceEvents: readonly SourceEvent[];
  readonly ticks: readonly MarketTick[];
}

// Orden canónico de ticks e incidencias (contratos de dominio, «Canonicalización y orden»). Quien
// lo produce es packages/domain/src/quality.ts, con comparadores propios que deben coincidir con
// estos; si cambia uno, cambian los dos (estado-del-codigo D-06).
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTicks(left: MarketTick, right: MarketTick): number {
  return (
    compareCodeUnits(left.event_time_utc, right.event_time_utc) ||
    compareCodeUnits(left.tick_fingerprint_sha256, right.tick_fingerprint_sha256) ||
    compareCodeUnits(left.observation_id, right.observation_id)
  );
}

function compareIncidents(left: DataQualityIncident, right: DataQualityIncident): number {
  return (
    compareCodeUnits(left.observed_at_utc, right.observed_at_utc) ||
    compareCodeUnits(left.incident_type, right.incident_type) ||
    compareCodeUnits(left.incident_id, right.incident_id)
  );
}

function sourceEventId(event: SourceEvent): string {
  return event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;
}

function fail(
  code:
    | 'DATASET_COUNT_MISMATCH'
    | 'DATASET_ORDER_INVALID'
    | 'DATASET_PROVENANCE_MISMATCH'
    | 'DATASET_RANGE_MISMATCH'
    | 'DATASET_REFERENCE_UNKNOWN'
    | 'DATASET_VERSION_MISMATCH',
  message: string,
  path: readonly (number | string)[],
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new ContractContextError({ code, context, message, path });
}

/**
 * Invariantes entre artefactos de un dataset que los esquemas por registro no expresan: conteos,
 * orden canónico, unión tick→raw, referencias de incidencias, procedencia y extremos temporales
 * (contratos de dominio, «Canonicalización y orden» y `DatasetManifestCore`). Recibe registros ya
 * validados por sus esquemas; la causalidad de condiciones se valida aparte con
 * `validateConditionCausality`.
 */
export function validateDatasetConsistency(input: DatasetConsistencyInput): void {
  const { conditions, core, incidents, sourceEvents, ticks } = input;
  const rawFrames = sourceEvents.filter((event) => event.kind === 'raw_source_frame');

  const counts = [
    ['source_event_count', core.source_event_count, sourceEvents.length],
    ['raw_frame_count', core.raw_frame_count, rawFrames.length],
    ['normalized_tick_count', core.normalized_tick_count, ticks.length],
    ['incident_count', core.incident_count, incidents.length],
    ['condition_event_count', core.condition_event_count, conditions.length],
  ] as const;
  for (const [field, declared, actual] of counts) {
    if (declared !== actual) {
      fail('DATASET_COUNT_MISMATCH', `${field} no corresponde a sus artefactos.`, [field], {
        actual,
        declared,
      });
    }
  }

  // Cada registro declara la misma versión que el manifiesto para su contrato (y las incidencias,
  // las mismas reglas): un lector nunca valida un registro con las reglas de otra versión.
  const versioned: [string, readonly { schema_version: string }[], string][] = [
    ['source_events', sourceEvents, core.source_event_schema_version],
    ['ticks', ticks, core.market_tick_schema_version],
    ['incidents', incidents, core.incident_schema_version],
    ['conditions', conditions, core.condition_event_schema_version],
  ];
  for (const [role, records, declared] of versioned) {
    const index = records.findIndex((record) => record.schema_version !== declared);
    if (index !== -1) {
      fail('DATASET_VERSION_MISMATCH', `schema_version distinta del manifiesto en ${role}.`, [
        role,
        index,
      ]);
    }
  }
  const ruleMismatch = incidents.findIndex(
    (incident) => incident.quality_rule_version !== core.quality_rule_version,
  );
  if (ruleMismatch !== -1) {
    fail('DATASET_VERSION_MISMATCH', 'quality_rule_version distinta del manifiesto.', [
      'incidents',
      ruleMismatch,
    ]);
  }

  const symbols = new Set(core.symbols);
  sourceEvents.forEach((event, index) => {
    if (
      event.source !== core.source ||
      (event.kind === 'raw_source_frame' && event.connector_version !== core.connector_version)
    ) {
      fail('DATASET_PROVENANCE_MISMATCH', 'Source event con otra procedencia.', [
        'source_events',
        index,
      ]);
    }
  });

  const rawById = new Map(rawFrames.map((event) => [event.observation_id, event]));
  ticks.forEach((tick, index) => {
    const raw = rawById.get(tick.observation_id);
    if (raw?.raw_payload_sha256 !== tick.raw_payload_sha256) {
      fail('DATASET_REFERENCE_UNKNOWN', 'Tick sin raw correspondiente.', ['ticks', index], {
        observation_id: tick.observation_id,
      });
    }
    if (
      tick.source !== core.source ||
      tick.connector_version !== core.connector_version ||
      !symbols.has(tick.symbol)
    ) {
      fail('DATASET_PROVENANCE_MISMATCH', 'Tick con otra procedencia.', ['ticks', index]);
    }
    const previous = ticks[index - 1];
    if (previous !== undefined && compareTicks(previous, tick) >= 0) {
      fail('DATASET_ORDER_INVALID', 'Ticks fuera de orden canónico.', ['ticks', index]);
    }
  });

  const knownRefs = new Set(sourceEvents.map(sourceEventId));
  incidents.forEach((incident, index) => {
    if (
      !knownRefs.has(incident.observed_ref) ||
      incident.related_refs.some((reference) => !knownRefs.has(reference))
    ) {
      fail('DATASET_REFERENCE_UNKNOWN', 'Incidencia con referencia desconocida.', [
        'incidents',
        index,
      ]);
    }
    if (
      incident.source !== core.source ||
      (incident.symbol !== null && !symbols.has(incident.symbol))
    ) {
      fail('DATASET_PROVENANCE_MISMATCH', 'Incidencia con otra procedencia.', ['incidents', index]);
    }
    const previous = incidents[index - 1];
    if (previous !== undefined && compareIncidents(previous, incident) >= 0) {
      fail('DATASET_ORDER_INVALID', 'Incidencias fuera de orden canónico.', ['incidents', index]);
    }
  });

  if (
    (ticks[0]?.event_time_utc ?? null) !== core.event_time_from_utc ||
    (ticks.at(-1)?.event_time_utc ?? null) !== core.event_time_to_utc
  ) {
    fail(
      'DATASET_RANGE_MISMATCH',
      'Los extremos temporales no coinciden con los ticks canónicos.',
      ['event_time_from_utc'],
    );
  }
}
