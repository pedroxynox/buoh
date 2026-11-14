import { describe, expect, it } from 'vitest';

import {
  ContractContextError,
  deriveEventId,
  derivePersistenceConditionKey,
  validateConditionCausality,
  type JsonValue,
} from '../src/index.js';

// El registro operativo de la publicación en `buoh_datasets` (ADR-0020 §9; contratos de dominio,
// «Registro operativo de persistencia y límites»). Una publicación no produce source events: la
// incidencia cita el `publication_id` del intento que falló y la resolución, la primera publicación
// confirmada después de la apertura. Solo ese registro pasa las publicaciones confirmadas.

const SOURCE = 'deriv_options';
const FAILED_ATTEMPT = '019a8000-0000-7000-8000-000000000001';
const PREVIOUS = '019a7fff-0000-7000-8000-000000000000';
const CONFIRMED = '019a8001-0000-7000-8000-000000000002';
const OPENED_AT = '2026-11-14T06:05:00.000Z';
const PUBLISHED_AT = '2026-11-14T06:10:00.000Z';

function withId<T extends Record<string, unknown>, K extends string>(
  body: T,
  field: K,
): T & Record<K, string> {
  return { ...body, [field]: deriveEventId(body as unknown as JsonValue) };
}

function incident() {
  return withId(
    {
      evidence: { reason: 'ECONNRESET', stage: 'manifest_commit' },
      incident_type: 'persistence_unavailable',
      observed_at_utc: OPENED_AT,
      observed_ref: FAILED_ATTEMPT,
      quality_rule_version: '1.0.0',
      related_refs: [PREVIOUS],
      schema_version: '1.0.0',
      severity: 'critical',
      source: SOURCE,
      symbol: null,
    },
    'incident_id',
  );
}

function opening(incidentId: string) {
  return withId(
    {
      action: 'opened',
      cause_refs: [incidentId],
      condition_key: derivePersistenceConditionKey(SOURCE, 'manifest_commit'),
      condition_type: 'persistence_unavailable',
      occurred_at_utc: OPENED_AT,
      schema_version: '1.0.0',
      source: SOURCE,
      symbol: null,
    },
    'condition_event_id',
  );
}

function resolution(openingId: string, evidence: string, at: string) {
  return withId(
    {
      action: 'resolved',
      cause_refs: [openingId, evidence].sort(),
      condition_key: derivePersistenceConditionKey(SOURCE, 'manifest_commit'),
      condition_type: 'persistence_unavailable',
      occurred_at_utc: at,
      resolution_reason: 'persistence_restored',
      schema_version: '1.0.0',
      source: SOURCE,
      symbol: null,
    },
    'condition_event_id',
  );
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ContractContextError);
    return (error as ContractContextError).code;
  }
}

describe('validateConditionCausality con publicaciones confirmadas (ADR-0020 §9)', () => {
  const failure = incident();
  const opened = opening(failure.incident_id);

  it('acepta la publicación confirmada siguiente como evidencia de la resolución', () => {
    const resolved = resolution(opened.condition_event_id, CONFIRMED, PUBLISHED_AT);
    const result = validateConditionCausality({
      conditions: [opened, resolved],
      confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: PUBLISHED_AT }],
      incidents: [failure],
      sourceEvents: [],
    });
    expect(result.openConditionTypes).toEqual([]);
  });

  it('fuera del registro de la publicación, un publication_id no es una referencia conocida', () => {
    const resolved = resolution(opened.condition_event_id, CONFIRMED, PUBLISHED_AT);
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, resolved],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_REFERENCE_UNKNOWN');
  });

  it('rechaza una publicación que no está entre las confirmadas', () => {
    const resolved = resolution(opened.condition_event_id, CONFIRMED, PUBLISHED_AT);
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, resolved],
          confirmedPublications: [{ publication_id: PREVIOUS, published_at_utc: OPENED_AT }],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_REFERENCE_UNKNOWN');
  });

  it('la resolución va a la hora de su publicación', () => {
    const resolved = resolution(opened.condition_event_id, CONFIRMED, '2026-11-14T06:11:00.000Z');
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, resolved],
          confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: PUBLISHED_AT }],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_PUBLICATION_MISMATCH');
  });

  it('una publicación confirmada antes de la apertura no resuelve nada', () => {
    // Un `commit_outcome_unknown` que la ejecución siguiente encuentra confirmado: su hora es
    // anterior a la apertura. Una resolución anterior a su apertura no la encuentra.
    const before = '2026-11-14T06:04:59.999Z';
    const resolved = resolution(opened.condition_event_id, CONFIRMED, before);
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, resolved],
          confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: before }],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_REFERENCE_UNKNOWN');
    // A la misma hora que la apertura, se recorre después de ella y la publicación no es posterior.
    const same = resolution(opened.condition_event_id, CONFIRMED, OPENED_AT);
    expect(same.condition_event_id > opened.condition_event_id).toBe(true);
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, same],
          confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: OPENED_AT }],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_PUBLICATION_MISMATCH');
  });

  it('en el registro de la publicación, la resolución cita una publicación confirmada', () => {
    // Otra referencia conocida, como la propia incidencia, no basta.
    const resolved = resolution(opened.condition_event_id, failure.incident_id, PUBLISHED_AT);
    expect(
      codeOf(() =>
        validateConditionCausality({
          conditions: [opened, resolved],
          confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: PUBLISHED_AT }],
          incidents: [failure],
          sourceEvents: [],
        }),
      ),
    ).toBe('CONDITION_PUBLICATION_MISMATCH');
  });

  it('sin publicaciones confirmadas, un source event posterior sigue resolviendo la persistencia', () => {
    // El registro del log: el primer evento durable tras recuperar (contratos de dominio).
    const event = {
      connection_id: '019a8002-0000-7000-8000-000000000003',
      event_id: '019a8002-0000-7000-8000-000000000004',
      kind: 'connection_opened',
      occurred_at_utc: PUBLISHED_AT,
      schema_version: '1.0.0',
      source: SOURCE,
      supersedes_connection_id: null,
    };
    const resolved = resolution(opened.condition_event_id, event.event_id, PUBLISHED_AT);
    expect(() =>
      validateConditionCausality({
        conditions: [opened, resolved],
        incidents: [failure],
        sourceEvents: [event],
      }),
    ).not.toThrow();
  });

  it('rechaza una publicación confirmada mal formada', () => {
    expect(() =>
      validateConditionCausality({
        conditions: [],
        confirmedPublications: [{ publication_id: 'no-es-uuid', published_at_utc: PUBLISHED_AT }],
        incidents: [],
        sourceEvents: [],
      }),
    ).toThrow();
    expect(() =>
      validateConditionCausality({
        conditions: [],
        confirmedPublications: [{ publication_id: CONFIRMED, published_at_utc: '2026-11-14' }],
        incidents: [],
        sourceEvents: [],
      }),
    ).toThrow();
  });
});
