import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ContractContextError,
  dataQualityIncidentSchema,
  datasetManifestSchema,
  deriveConnectionConditionKey,
  deriveEventId,
  deriveGapConditionKey,
  healthReportSchema,
  ingestionCursorSchema,
  marketTickSchema,
  operationalConditionEventSchema,
  reduceOpenConditions,
  sha256Hex,
  sourceEventSchema,
  validateConditionCausality,
  validatePublicationRecord,
  type JsonValue,
} from '../src/index.js';

const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(vectorRoot, relativePath), 'utf8')) as unknown;
}

function readLines(relativePath: string): unknown[] {
  return readFileSync(resolve(vectorRoot, relativePath), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe('SourceEvent e IngestionCursor', () => {
  it('valida el frame raw y rechaza hash o campos desconocidos', () => {
    const raw = sourceEventSchema.parse(readLines('expected-source-events-000000.ndjson')[0]);
    expect(raw.kind).toBe('raw_source_frame');

    if (raw.kind !== 'raw_source_frame') {
      throw new TypeError('Fixture inesperado.');
    }
    expect(
      sourceEventSchema.safeParse({ ...raw, raw_payload_sha256: '0'.repeat(64) }).success,
    ).toBe(false);
    expect(sourceEventSchema.safeParse({ ...raw, extra: true }).success).toBe(false);

    const malformedUnicode = '\ud800';
    expect(
      sourceEventSchema.safeParse({
        ...raw,
        payload_utf8: malformedUnicode,
        raw_payload_sha256: sha256Hex(malformedUnicode),
      }).success,
    ).toBe(false);
  });

  it('valida un cursor durable y rechaza campos extra', () => {
    const cursor = {
      schema_version: '1.0.0',
      source: 'synthetic',
      symbol: 'SYNTH_100',
      connection_id: '019b76da-a800-7000-8000-000000000000',
      active_segment_index: 1,
      source_event_count: 11,
      last_durable_source_event_id: '019b76da-c940-7000-8000-000000000012',
      last_durable_observation_id: '019b76da-c940-7000-8000-000000000012',
      high_watermark_event_time_utc: '2026-01-01T00:00:06.000Z',
      updated_at_utc: '2026-01-01T00:00:08.500Z',
    };

    expect(ingestionCursorSchema.parse(cursor)).toEqual(cursor);
    expect(ingestionCursorSchema.safeParse({ ...cursor, hidden: true }).success).toBe(false);
  });
});

describe('MarketTick', () => {
  it('valida escala, orden de flags y fingerprint', () => {
    const tick = marketTickSchema.parse(readLines('expected-ticks.ndjson')[0]);
    expect(tick.quote_decimal).toBe('100.130');

    expect(marketTickSchema.safeParse({ ...tick, quote_decimal: '100.13' }).success).toBe(false);
    expect(
      marketTickSchema.safeParse({ ...tick, tick_fingerprint_sha256: '0'.repeat(64) }).success,
    ).toBe(false);
    expect(
      marketTickSchema.safeParse({
        ...tick,
        quality_flags: ['source_time_conflict', 'delivery_delayed'],
      }).success,
    ).toBe(false);
  });
});

describe('DataQualityIncident', () => {
  it('valida IDs derivados y evidencia discriminada', () => {
    const incident = dataQualityIncidentSchema.parse(readLines('expected-incidents.ndjson')[0]);
    expect(incident.incident_type).toBe('duplicate_exact');
    expect(
      dataQualityIncidentSchema.safeParse({ ...incident, incident_id: `sha256:${'0'.repeat(64)}` })
        .success,
    ).toBe(false);
  });

  it('relaciona la unidad con el recurso de límite', () => {
    const body = {
      schema_version: '1.0.0',
      incident_type: 'source_limit_exceeded',
      severity: 'error',
      quality_rule_version: '1.0.0',
      source: 'synthetic',
      symbol: null,
      observed_at_utc: '2026-01-01T00:00:10.000Z',
      observed_ref: '019b76da-cf10-7000-8000-000000000099',
      related_refs: [],
      evidence: {
        resource: 'in_memory_queue_events',
        unit: 'events',
        observed_value: 1001,
        maximum_value: 1000,
      },
    } as const;
    const valid = { ...body, incident_id: deriveEventId(body as unknown as JsonValue) };
    expect(dataQualityIncidentSchema.parse(valid).incident_type).toBe('source_limit_exceeded');

    const invalidBody = {
      ...body,
      evidence: { ...body.evidence, unit: 'bytes' as const },
    };
    const invalid = {
      ...invalidBody,
      incident_id: deriveEventId(invalidBody as unknown as JsonValue),
    };
    expect(dataQualityIncidentSchema.safeParse(invalid).success).toBe(false);
  });

  it('admite invalid_source_frame sin símbolo solo desde el esquema de incidencias 2.0.0', () => {
    const withVersion = (schemaVersion: string) => {
      const body = {
        evidence: { raw_payload_sha256: 'a'.repeat(64), reason: 'payload_not_json' },
        incident_type: 'invalid_source_frame',
        observed_at_utc: '2026-01-01T00:00:00.100Z',
        observed_ref: '019b76da-a800-7000-8000-000000000001',
        quality_rule_version: '1.1.0',
        related_refs: [],
        schema_version: schemaVersion,
        severity: 'error',
        source: 'deriv',
        symbol: null,
      };
      return { ...body, incident_id: deriveEventId(body) };
    };
    expect(dataQualityIncidentSchema.safeParse(withVersion('1.0.0')).success).toBe(false);
    expect(dataQualityIncidentSchema.safeParse(withVersion('2.0.0')).success).toBe(true);
  });
});

describe('OperationalConditionEvent', () => {
  it('deriva claves canónicas y reduce apertura/resolución', () => {
    expect(deriveConnectionConditionKey('synthetic', '019b76da-a800-7000-8000-000000000000')).toBe(
      'connection_lost:sha256:15eef6823f99e6182dbc9d90f6b36a7b935eb12859a85ebe3f8f0e0829ec6116',
    );
    expect(
      deriveGapConditionKey({
        from_event_time_utc: '2026-01-01T00:00:02.001Z',
        source: 'synthetic',
        symbol: 'SYNTH_100',
        to_event_time_utc: '2026-01-01T00:00:04.999Z',
      }),
    ).toBe(
      'event_gap_unresolved:sha256:a3ac2ef3e862f4f2c0d4ed5a99c76c1ab9b133e3c7c51f6d3d03f1b0d39ec756',
    );

    const conditions = readLines('expected-conditions.ndjson').map((condition) =>
      operationalConditionEventSchema.parse(condition),
    );
    expect(reduceOpenConditions(conditions)).toEqual(['event_gap_unresolved']);

    const sourceEvents = [
      ...readLines('expected-source-events-000000.ndjson'),
      ...readLines('expected-source-events-000001.ndjson'),
    ];
    const incidents = readLines('expected-incidents.ndjson');
    expect(
      validateConditionCausality({ conditions, incidents, sourceEvents }).openConditionTypes,
    ).toEqual(['event_gap_unresolved']);

    const fake = { ...conditions[0], condition_key: `connection_lost:sha256:${'0'.repeat(64)}` };
    const fakeBody = { ...fake } as Record<string, unknown>;
    delete fakeBody['condition_event_id'];
    const fakeWithValidId = {
      ...fake,
      condition_event_id: deriveEventId(fakeBody as JsonValue),
    };
    expect(operationalConditionEventSchema.safeParse(fakeWithValidId).success).toBe(true);
    let contextError: unknown;
    try {
      validateConditionCausality({
        conditions: [fakeWithValidId, ...conditions.slice(1)],
        incidents,
        sourceEvents,
      });
    } catch (error) {
      contextError = error;
    }
    expect(contextError).toBeInstanceOf(ContractContextError);
    expect((contextError as ContractContextError).code).toBe('CONDITION_IDENTITY_MISMATCH');
    expect((contextError as ContractContextError).path).toContain('condition_key');

    const resolution = { ...conditions[1], source: 'other-source' };
    const resolutionBody = { ...resolution } as Record<string, unknown>;
    delete resolutionBody['condition_event_id'];
    const alienResolution = {
      ...resolution,
      condition_event_id: deriveEventId(resolutionBody as JsonValue),
    };
    expect(() =>
      validateConditionCausality({
        conditions: [conditions[0], alienResolution, conditions[2]],
        incidents,
        sourceEvents,
      }),
    ).toThrow(/cambia la identidad/u);

    const alienReconnect = sourceEvents.map((event) =>
      typeof event === 'object' &&
      event !== null &&
      'kind' in event &&
      event.kind === 'connection_opened'
        ? { ...event, source: 'other-source' }
        : event,
    );
    expect(() =>
      validateConditionCausality({ conditions, incidents, sourceEvents: alienReconnect }),
    ).toThrow(/Reconexión causal inválida/u);
  });

  it('rechaza resolución sin apertura', () => {
    const resolved = operationalConditionEventSchema.parse(
      readLines('expected-conditions.ndjson')[1],
    );
    expect(() => reduceOpenConditions([resolved])).toThrow(/sin apertura/u);
  });
});

describe('DatasetManifest y publicación', () => {
  it('valida manifiesto, objetos y registro de publicación', () => {
    const dataset = datasetManifestSchema.parse(readJson('expected-dataset.json'));
    const publication = readJson('expected-publication-record.json');

    expect(dataset.manifest_core.logical_artifacts).toHaveLength(5);
    expect(validatePublicationRecord(publication, dataset).state).toBe('active');
    expect(
      datasetManifestSchema.safeParse({ ...dataset, dataset_id: `sha256:${'0'.repeat(64)}` })
        .success,
    ).toBe(false);

    const lastObject = dataset.storage_objects.at(-1);
    if (lastObject === undefined) {
      throw new TypeError('Fixture sin objetos físicos.');
    }
    const extraObject = {
      ...lastObject,
      artifact_id: 'source_schema:000001',
      uri: 'fixture://extra-source-schema.json',
    };
    expect(
      datasetManifestSchema.safeParse({
        ...dataset,
        storage_objects: [...dataset.storage_objects, extraObject],
      }).success,
    ).toBe(false);
  });

  it('acepta la identidad canónica de cero ticks', () => {
    const dataset = datasetManifestSchema.parse(readJson('zero-valid-ticks/expected-dataset.json'));

    expect(dataset.manifest_core.normalized_tick_count).toBe(0);
    expect(dataset.manifest_core.event_time_from_utc).toBeNull();
    expect(dataset.manifest_core.event_time_to_utc).toBeNull();
  });
});

describe('HealthReport', () => {
  it('valida condiciones abiertas ordenadas', () => {
    const health = healthReportSchema.parse(readJson('expected-health.json'));
    expect(health.open_condition_types).toEqual(['event_gap_unresolved']);
    expect(
      healthReportSchema.safeParse({
        ...health,
        open_condition_types: ['source_limit_exceeded', 'event_gap_unresolved'],
      }).success,
    ).toBe(false);
    expect(
      healthReportSchema.safeParse({
        ...health,
        connection_state: 'disconnected',
        service_health: 'healthy',
      }).success,
    ).toBe(false);
  });
});
