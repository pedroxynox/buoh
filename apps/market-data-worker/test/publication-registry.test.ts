import { validateConditionCausality } from '@buoh/contracts';
import { evaluateSourceLimit } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import { OperationalRegistry } from '../src/operational/registry.js';
import { MemoryOperationalStore } from './support/memory-stores.js';

// El registro operativo de la publicación, en `buoh_datasets` (ADR-0020 §9): una escritura que falla
// abre `persistence_unavailable` con el `publication_id` del intento, y la primera publicación
// confirmada después de la apertura la resuelve. Sin red, reloj real ni azar.

const SOURCE = 'deriv_options';
const PREVIOUS = '019a7fff-0000-7000-8000-000000000000';
const FAILED = '019a8000-0000-7000-8000-000000000001';
const CONFIRMED = '019a8001-0000-7000-8000-000000000002';

function violation() {
  const exceeded = evaluateSourceLimit('websocket_frame', 2_000_000);
  if (exceeded === null) throw new Error('sin límite');
  return exceeded;
}

async function openedRegistry(store = new MemoryOperationalStore()) {
  const alerts: Readonly<Record<string, string | null>>[] = [];
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: SOURCE,
    store,
  });
  const recorded = await registry.recordPersistenceUnavailable({
    observed_at_utc: '2026-11-14T06:05:00.000Z',
    observed_ref: FAILED,
    reason: 'ECONNRESET',
    related_refs: [PREVIOUS],
    stage: 'normalized_object_write',
  });
  return { alerts, recorded, registry, store };
}

describe('resolveWithPublication (ADR-0020 §9)', () => {
  it('la primera publicación confirmada después de la apertura la resuelve', async () => {
    const { recorded, registry, store } = await openedRegistry();
    expect(recorded.status).toBe('recorded');
    const [opening] = registry.openConditions();
    if (opening === undefined) throw new Error('sin apertura');

    const result = await registry.resolveWithPublication({
      publication_id: CONFIRMED,
      published_at_utc: '2026-11-14T06:10:00.000Z',
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]).toMatchObject({
      action: 'resolved',
      cause_refs: [CONFIRMED, opening.condition_event_id].sort(),
      condition_key: opening.condition_key,
      condition_type: 'persistence_unavailable',
      occurred_at_utc: '2026-11-14T06:10:00.000Z',
      resolution_reason: 'persistence_restored',
      source: SOURCE,
      symbol: null,
    });
    expect(registry.openConditions()).toEqual([]);
    // Lo guardado es coherente con el contrato del registro de la publicación.
    expect(
      validateConditionCausality({
        conditions: store.conditions,
        confirmedPublications: [
          { publication_id: CONFIRMED, published_at_utc: '2026-11-14T06:10:00.000Z' },
        ],
        incidents: store.incidents,
        sourceEvents: [],
      }).openConditionTypes,
    ).toEqual([]);
    // La incidencia cita el intento y la última publicación confirmada, sin símbolo.
    expect(store.incidents[0]).toMatchObject({
      evidence: { reason: 'ECONNRESET', stage: 'normalized_object_write' },
      observed_ref: FAILED,
      related_refs: [PREVIOUS],
      symbol: null,
    });
  });

  it('una publicación anterior a la apertura, o de su misma hora, no resuelve nada', async () => {
    // El `commit_outcome_unknown` que la ejecución siguiente encuentra confirmado.
    const { registry, store } = await openedRegistry();
    for (const at of ['2026-11-14T06:04:59.000Z', '2026-11-14T06:05:00.000Z']) {
      const result = await registry.resolveWithPublication({
        publication_id: CONFIRMED,
        published_at_utc: at,
      });
      expect(result).toEqual({ conditions: [], incident: null, status: 'recorded' });
    }
    expect(registry.openConditionTypes()).toEqual(['persistence_unavailable']);
    expect(store.conditions).toHaveLength(1);
  });

  it('sin condiciones abiertas no escribe nada', async () => {
    const store = new MemoryOperationalStore();
    const registry = await OperationalRegistry.open({ source: SOURCE, store });
    store.failAppend = true;
    expect(
      await registry.resolveWithPublication({
        publication_id: CONFIRMED,
        published_at_utc: '2026-11-14T06:10:00.000Z',
      }),
    ).toEqual({ conditions: [], incident: null, status: 'recorded' });
  });

  it('una condición de otra ejecución también se resuelve', async () => {
    const { store } = await openedRegistry();
    const reopened = await OperationalRegistry.open({ source: SOURCE, store });
    const result = await reopened.resolveWithPublication({
      publication_id: CONFIRMED,
      published_at_utc: '2026-11-14T06:10:00.000Z',
    });
    expect(result.status === 'recorded' ? result.conditions.length : -1).toBe(1);
    expect(reopened.openConditions()).toEqual([]);
  });

  it('no resuelve un límite de la fuente', async () => {
    const store = new MemoryOperationalStore();
    const registry = await OperationalRegistry.open({ source: SOURCE, store });
    await registry.recordSourceLimitExceeded({
      observed_at_utc: '2026-11-14T06:05:00.000Z',
      observed_ref: FAILED,
      related_refs: [],
      violation: violation(),
    });
    expect(
      await registry.resolveWithPublication({
        publication_id: CONFIRMED,
        published_at_utc: '2026-11-14T06:10:00.000Z',
      }),
    ).toEqual({ conditions: [], incident: null, status: 'recorded' });
    expect(registry.openConditionTypes()).toEqual(['source_limit_exceeded']);
  });

  it('sin PostgreSQL solo deja la alerta saneada, con la publicación', async () => {
    const { alerts, registry, store } = await openedRegistry();
    store.failAppend = true;
    const result = await registry.resolveWithPublication({
      publication_id: CONFIRMED,
      published_at_utc: '2026-11-14T06:10:00.000Z',
    });
    expect(result).toEqual({ status: 'alert_only' });
    expect(alerts).toEqual([
      {
        event: 'operational_registry_unavailable',
        observed_ref: CONFIRMED,
        operation: 'resolve',
        reason: 'ECONNREFUSED',
      },
    ]);
    expect(registry.openConditionTypes()).toEqual(['persistence_unavailable']);
  });
});
