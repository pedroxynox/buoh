import { resolve } from 'node:path';

import { validateConditionCausality } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  CommitOutcomeUnknownError,
  loadSyntheticFixture,
  OperationalRegistry,
  PublicationConflictError,
  PublicationError,
  PublicationLimitError,
  publishLiveDataset,
  replayDataset,
  type DatasetPlan,
  type PublishLiveDatasetInput,
  type SyntheticFixture,
} from '../src/index.js';
import {
  MemoryDatasetStore,
  MemoryObjectStore,
  MemoryOperationalStore,
} from './support/memory-stores.js';

// La publicación de un dataset vivo en `buoh_datasets` (ADR-0020 §5, §7 y §9; PR 3b de su §13): la
// fila de rango en el mismo commit, el `COMMIT` ambiguo, la comprobación previa del reintento y el
// registro operativo de la publicación. Almacenes en memoria, sin red, reloj real ni azar.

const VECTORS = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const ATTEMPT_1 = '019a8000-0000-7000-8000-000000000001';
const ATTEMPT_2 = '019a8000-0000-7000-8000-000000000002';
const ATTEMPT_3 = '019a8000-0000-7000-8000-000000000003';
const AT_1 = '2026-11-14T06:05:00.000Z';
const AT_2 = '2026-11-14T06:10:00.000Z';
const AT_3 = '2026-11-14T06:15:00.000Z';

type Due = Extract<DatasetPlan, { status: 'due' }>;

let fixturePromise: Promise<SyntheticFixture> | undefined;
async function fixture(): Promise<SyntheticFixture> {
  fixturePromise ??= loadSyntheticFixture(VECTORS);
  return fixturePromise;
}

async function plan(
  scenario: 'principal' | 'zero-valid-ticks',
  from = 0,
  open: Due['open'] = { open_condition_types: [], pending_continuity_symbols: [] },
): Promise<Due> {
  const loaded = await fixture();
  const found = loaded.scenarios.find((item) => item.name === scenario);
  if (found === undefined) throw new TypeError(`Falta ${scenario}.`);
  return {
    clean:
      open.pending_continuity_symbols.length === 0 &&
      !open.open_condition_types.includes('connection_lost'),
    elements: found.segments.flat().length,
    from,
    open,
    segments: found.segments,
    status: 'due',
    to: from + found.segments.length - 1,
  };
}

async function harness() {
  const store = new MemoryDatasetStore();
  const objects = new MemoryObjectStore();
  const operational = new MemoryOperationalStore();
  const alerts: Readonly<Record<string, string | null>>[] = [];
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: 'synthetic',
    store: operational,
  });
  const loaded = await fixture();
  const publish = async (
    due: Due,
    publication_id: string,
    published_at_utc: string,
    overrides: Partial<PublishLiveDatasetInput> = {},
  ) =>
    publishLiveDataset({
      environment: 'test',
      logNumber: 1,
      now: () => published_at_utc.replace(/:00\.000Z$/u, ':30.000Z'),
      objects,
      plan: due,
      profile: loaded.profile,
      publication_id,
      published_at_utc,
      registry,
      store,
      zlibVersion: 'test-zlib',
      ...overrides,
    });
  return { alerts, objects, operational, publish, registry, store };
}

describe('publishLiveDataset (ADR-0020 §9)', () => {
  it('publica el dataset en gzip con su fila de rango en el mismo commit, y se reproduce en los dos modos', async () => {
    const { objects, publish, store } = await harness();
    const due = await plan('principal', 0, {
      open_condition_types: ['event_gap_unresolved'],
      pending_continuity_symbols: [],
    });
    const outcome = await publish(due, ATTEMPT_1, AT_1);
    expect(outcome.status).toBe('published');
    if (outcome.status !== 'published') return;
    const datasetId = outcome.publication.dataset_id;
    expect(outcome.range).toEqual({
      clean: true,
      first_segment: 0,
      last_segment: due.to,
      log_number: 1,
      open: { open_condition_types: ['event_gap_unresolved'], pending_continuity_symbols: [] },
    });
    expect(store.ranges.get(datasetId)).toEqual({
      publication_id: ATTEMPT_1,
      range: outcome.range,
    });
    const derived = outcome.publication.manifest.storage_objects.filter((object) =>
      ['normalized_ticks', 'quality_incidents', 'operational_conditions'].includes(object.role),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((object) => object.compression === 'gzip')).toBe(true);
    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId,
        environment: 'test',
        metadata: store,
        mode,
        objects,
      });
      expect(report.dataset_id).toBe(datasetId);
    }
  });

  it('un final que no fue limpio queda en su fila de rango', async () => {
    const { publish } = await harness();
    const outcome = await publish(
      await plan('principal', 0, {
        open_condition_types: ['connection_lost'],
        pending_continuity_symbols: ['SYNTH_100'],
      }),
      ATTEMPT_1,
      AT_1,
    );
    expect(outcome.status === 'published' ? outcome.range : null).toMatchObject({
      clean: false,
      open: {
        open_condition_types: ['connection_lost'],
        pending_continuity_symbols: ['SYNTH_100'],
      },
    });
  });

  it('un COMMIT que se confirmó pero se informó ambiguo: el reintento lo encuentra y no lo repite', async () => {
    const { operational, publish, registry, store } = await harness();
    const due = await plan('principal');
    store.ambiguousCommit = 'confirmed';
    const failure = await publish(due, ATTEMPT_1, AT_1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(failure).toMatchObject({ reason: 'commit_outcome_unknown', step: 'manifest_commit' });
    // Abre persistence_unavailable con la etapa del commit, el intento y ninguna anterior.
    expect(operational.incidents).toHaveLength(1);
    expect(operational.incidents[0]).toMatchObject({
      evidence: { reason: 'commit_outcome_unknown', stage: 'manifest_commit' },
      observed_at_utc: '2026-11-14T06:05:30.000Z',
      observed_ref: ATTEMPT_1,
      related_refs: [],
      symbol: null,
    });
    expect(registry.openConditionTypes()).toEqual(['persistence_unavailable']);

    const retry = await publish(due, ATTEMPT_2, AT_2);
    expect(retry.status).toBe('already_published');
    if (retry.status !== 'already_published') return;
    expect(retry.record.publication_id).toBe(ATTEMPT_1);
    expect(store.records).toHaveLength(1);
    // Su hora es anterior a la apertura: no resuelve nada.
    expect(registry.openConditionTypes()).toEqual(['persistence_unavailable']);

    // La publicación nueva siguiente lo resuelve.
    const next = await publish(await plan('zero-valid-ticks', due.to + 1), ATTEMPT_3, AT_3);
    expect(next.status).toBe('published');
    expect(registry.openConditionTypes()).toEqual([]);
    expect(operational.conditions.at(-1)).toMatchObject({
      action: 'resolved',
      occurred_at_utc: AT_3,
      resolution_reason: 'persistence_restored',
    });
    expect(
      validateConditionCausality({
        conditions: operational.conditions,
        confirmedPublications: [{ publication_id: ATTEMPT_3, published_at_utc: AT_3 }],
        incidents: operational.incidents,
        sourceEvents: [],
      }).openConditionTypes,
    ).toEqual([]);
  });

  it('un COMMIT ambiguo que no se confirmó: el reintento lo publica con otro publication_id y resuelve la condición', async () => {
    const { operational, publish, registry, store } = await harness();
    const due = await plan('principal');
    store.ambiguousCommit = 'not_confirmed';
    await expect(publish(due, ATTEMPT_1, AT_1)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(store.records).toHaveLength(0);

    const retry = await publish(due, ATTEMPT_2, AT_2);
    expect(retry.status).toBe('published');
    expect(store.records.map((entry) => entry.record.publication_id)).toEqual([ATTEMPT_2]);
    expect(registry.openConditionTypes()).toEqual([]);
    expect(operational.conditions.at(-1)?.cause_refs).toContain(ATTEMPT_2);
  });

  it('una publicación activa sin su fila de rango, o con otro rango, es publication_conflict, sin registro', async () => {
    for (const variant of ['without', 'other'] as const) {
      const { operational, publish, store } = await harness();
      const due = await plan('principal');
      const first = await publish(due, ATTEMPT_1, AT_1);
      if (first.status !== 'published') throw new Error('sin publicar');
      const datasetId = first.publication.dataset_id;
      if (variant === 'without') {
        store.ranges.delete(datasetId);
      } else {
        const stored = store.ranges.get(datasetId);
        if (stored === undefined) throw new Error('sin rango');
        store.ranges.set(datasetId, {
          ...stored,
          range: { ...stored.range, last_segment: stored.range.last_segment + 1 },
        });
      }
      const failure = await publish(due, ATTEMPT_2, AT_2).catch((error: unknown) => error);
      expect(failure, variant).toBeInstanceOf(PublicationConflictError);
      expect(failure).toMatchObject({ reason: 'publication_conflict', step: 'precondition' });
      expect(operational.incidents, variant).toHaveLength(0);
    }
  });

  it('una fila de rango de otra publicación del dataset, y no de la activa, es publication_conflict', async () => {
    const { publish, store } = await harness();
    const due = await plan('principal');
    const first = await publish(due, ATTEMPT_1, AT_1);
    if (first.status !== 'published') throw new Error('sin publicar');
    const stored = store.ranges.get(first.publication.dataset_id);
    if (stored === undefined) throw new Error('sin rango');
    store.ranges.set(first.publication.dataset_id, { ...stored, publication_id: ATTEMPT_3 });
    const failure = await publish(due, ATTEMPT_2, AT_2).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicationConflictError);
    expect(failure).toMatchObject({ kind: 'log_range', step: 'precondition' });
  });

  it('lo que dejó abierto va único y ordenado, y el reintento no depende de su orden', async () => {
    const { publish } = await harness();
    const due = await plan('principal', 0, {
      open_condition_types: [
        'source_limit_exceeded',
        'event_gap_unresolved',
        'event_gap_unresolved',
      ],
      pending_continuity_symbols: ['SYNTH_200', 'SYNTH_100', 'SYNTH_200'],
    });
    const first = await publish(due, ATTEMPT_1, AT_1);
    expect(first.range.open).toEqual({
      open_condition_types: ['event_gap_unresolved', 'source_limit_exceeded'],
      pending_continuity_symbols: ['SYNTH_100', 'SYNTH_200'],
    });
    const reordered = {
      ...due,
      open: {
        open_condition_types: ['event_gap_unresolved', 'source_limit_exceeded'],
        pending_continuity_symbols: ['SYNTH_100', 'SYNTH_200'],
      },
    };
    expect((await publish(reordered, ATTEMPT_2, AT_2)).status).toBe('already_published');
  });

  it('el reintento con otro final no cuenta como publicado: cada campo del rango cuenta', async () => {
    const { publish, store } = await harness();
    const due = await plan('principal');
    const first = await publish(due, ATTEMPT_1, AT_1);
    if (first.status !== 'published') throw new Error('sin publicar');
    // Cada variante cambia un solo campo del rango, con el mismo contenido.
    for (const changed of [
      { ...due, from: due.from + 1 },
      { ...due, to: due.to + 1 },
      { ...due, clean: false },
      { ...due, open: { ...due.open, pending_continuity_symbols: ['SYNTH_100'] } },
      { ...due, open: { ...due.open, open_condition_types: ['event_gap_unresolved'] } },
    ]) {
      await expect(publish(changed, ATTEMPT_2, AT_2)).rejects.toBeInstanceOf(
        PublicationConflictError,
      );
    }
    await expect(publish(due, ATTEMPT_2, AT_2, { logNumber: 2 })).rejects.toBeInstanceOf(
      PublicationConflictError,
    );
    expect(store.records).toHaveLength(1);
  });

  it('una escritura que falla abre persistence_unavailable con su etapa y la última publicación confirmada', async () => {
    const { objects, operational, publish } = await harness();
    const first = await publish(await plan('principal'), ATTEMPT_1, AT_1);
    expect(first.status).toBe('published');
    objects.armNextPutFailure('ECONNRESET');
    const due = await plan('zero-valid-ticks', 2);
    const failure = await publish(due, ATTEMPT_2, AT_2).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicationError);
    expect(failure).toMatchObject({ step: 'normalized_object_write' });
    expect(operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: 'ECONNRESET', stage: 'normalized_object_write' },
        incident_type: 'persistence_unavailable',
        observed_ref: ATTEMPT_2,
        related_refs: [ATTEMPT_1],
        severity: 'critical',
        source: 'synthetic',
        symbol: null,
      }),
    ]);
  });

  it('un fallo del commit que no es ambiguo también abre la condición, con la etapa del commit', async () => {
    const { operational, publish, store } = await harness();
    store.failCommit = true;
    await expect(publish(await plan('principal'), ATTEMPT_1, AT_1)).rejects.toMatchObject({
      step: 'manifest_commit',
    });
    expect(operational.incidents[0]?.evidence).toEqual({
      reason: 'Error',
      stage: 'manifest_commit',
    });
  });

  it('los límites del replay y la consulta previa fallan sin escribir ni registrar nada', async () => {
    {
      const { objects, operational, publish } = await harness();
      const failure = await publish(await plan('principal'), ATTEMPT_1, AT_1, {
        limits: { gzip_logical_bytes: 1, manifest_document_bytes: 1, object_bytes: 1 },
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PublicationLimitError);
      expect(objects.objects.size).toBe(0);
      expect(operational.incidents).toHaveLength(0);
    }
    {
      const { objects, operational, publish, store } = await harness();
      store.failReads = true;
      const failure = await publish(await plan('principal'), ATTEMPT_1, AT_1).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PublicationError);
      expect(failure).toMatchObject({ step: 'precondition' });
      expect(objects.objects.size).toBe(0);
      expect(operational.incidents).toHaveLength(0);
    }
    {
      // También la consulta previa de la escritura, después de la del reintento.
      const { objects, operational, publish, store } = await harness();
      store.failActiveLookup = true;
      const failure = await publish(await plan('principal'), ATTEMPT_1, AT_1).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PublicationError);
      expect(failure).toMatchObject({ step: 'precondition' });
      expect(objects.objects.size).toBe(0);
      expect(operational.incidents).toHaveLength(0);
    }
  });

  it('un rango que no empieza tras el último del log es publication_conflict, sin registro', async () => {
    const { operational, publish } = await harness();
    const failure = await publish(await plan('principal', 1), ATTEMPT_1, AT_1).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PublicationConflictError);
    expect(failure).toMatchObject({ reason: 'publication_conflict', step: 'manifest_commit' });
    expect(operational.incidents).toHaveLength(0);
  });
});
