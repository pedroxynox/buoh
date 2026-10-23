import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rawSourceFrameSchema, sha256Hex, type SourceEvent } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildDatasetPublication,
  createPipelineProfile,
  deriveMarketData,
  normalizeRawFrame,
  RULE_SETS,
  SymbolAttributionError,
  type PipelineProfile,
} from '../src/index.js';

// Reglas de calidad 1.1.0 (contratos de dominio, «Semántica ejecutable de reglas 1.1.0»): mensajes
// que no son ticks, frames de error de la fuente, atribución por `echo_req` e incidencia sin
// símbolo. Decididas por el propietario antes de F1.4; los vectores v1 siguen en reglas 1.0.0.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const CONNECTION = '019b76da-a800-7000-8000-00000000a000';

/** Esquema de fuente de prueba: el del vector v1 con dos símbolos permitidos. */
function twoSymbolSchema(): Buffer {
  const schema = JSON.parse(readFileSync(resolve(vectorRoot, 'source-schema.json'), 'utf8')) as {
    properties: { tick: { properties: { symbol: unknown } } };
  };
  schema.properties.tick.properties.symbol = { enum: ['SYNTH_100', 'SYNTH_200'] };
  return Buffer.from(JSON.stringify(schema));
}

function profileFor(ruleVersion: '1.0.0' | '1.1.0', symbols: string[]): PipelineProfile {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(
      JSON.stringify({
        allowed_symbols: symbols,
        gap_detection: 'after_reconnection',
        maximum_delivery_delay_ms: 2000,
        maximum_event_gap_ms: 2000,
        profile_id: `test-rules-${ruleVersion}`,
        quality_rule_version: ruleVersion,
        source: 'synthetic',
      }),
    ),
    source_schema_bytes: twoSymbolSchema(),
    source_schema_release: 'test',
  });
}

function raw(sequence: number, payload: string, receivedAt = '2026-01-01T00:00:00.100Z') {
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`,
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: receivedAt,
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

const tick = (symbol: string, epoch = 1767225600) =>
  `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":100.125,"symbol":"${symbol}"}}`;
const PING = '{"echo_req":{"ping":1,"req_id":7},"msg_type":"ping","ping":"pong","req_id":7}';
const TICK_ERROR =
  '{"echo_req":{"subscribe":1,"ticks":"SYNTH_200"},"error":{"code":"MarketIsClosed","message":"closed"},"msg_type":"tick"}';
const UNATTRIBUTABLE = '{"msg_type":"tick","tick":{"quote":"x"}}';

describe('reglas de calidad 1.1.0', () => {
  const multi = profileFor('1.1.0', ['SYNTH_100', 'SYNTH_200']);

  it('fija normalizador 1.1.0 y esquema de incidencias 2.0.0', () => {
    expect(multi.rules).toEqual(RULE_SETS['1.1.0']);
    expect(multi.rules).toMatchObject({
      incident_schema_version: '2.0.0',
      normalizer_version: '1.1.0',
    });
  });

  it('un mensaje que no es tick no produce tick ni incidencia', () => {
    expect(normalizeRawFrame(raw(1, PING), multi)).toEqual({
      msg_type: 'ping',
      ok: false,
      reason: 'non_tick',
    });
    const derived = deriveMarketData([[raw(1, PING), raw(2, tick('SYNTH_100'))]], multi);
    expect(derived.ticks.map((item) => item.observation_id)).toEqual([
      raw(2, tick('SYNTH_100')).observation_id,
    ]);
    expect(derived.incidents).toEqual([]);
  });

  it('un frame de error de la fuente es inválido y se atribuye por echo_req', () => {
    expect(normalizeRawFrame(raw(1, TICK_ERROR), multi)).toEqual({
      ok: false,
      reason: 'source_error_response',
      symbol: 'SYNTH_200',
    });
  });

  it('sin símbolo atribuible registra la incidencia sin símbolo y la derivación continúa', () => {
    const events: SourceEvent[] = [raw(1, UNATTRIBUTABLE), raw(2, tick('SYNTH_200'))];
    const derived = deriveMarketData([events], multi);
    expect(derived.ticks.map((item) => item.symbol)).toEqual(['SYNTH_200']);
    expect(derived.incidents).toHaveLength(1);
    expect(derived.incidents[0]).toMatchObject({
      evidence: { reason: 'schema_validation_failed' },
      incident_type: 'invalid_source_frame',
      quality_rule_version: '1.1.0',
      schema_version: '2.0.0',
      symbol: null,
    });
  });

  it('las reglas 1.0.0 conservan su semántica: sin atribución con varios símbolos abortan', () => {
    const legacy = profileFor('1.0.0', ['SYNTH_100', 'SYNTH_200']);
    expect(() => normalizeRawFrame(raw(1, UNATTRIBUTABLE), legacy)).toThrow(SymbolAttributionError);
    // Y no clasifican por msg_type: un ping es un tick inválido para 1.0.0.
    expect(normalizeRawFrame(raw(1, PING), profileFor('1.0.0', ['SYNTH_100']))).toMatchObject({
      ok: false,
      reason: 'schema_validation_failed',
    });
  });

  it('la publicación declara las versiones de las reglas 1.1.0', () => {
    const publication = buildDatasetPublication({
      locateManifest: () => 's3://buoh-test/manifest',
      locateObject: () => 's3://buoh-test/object',
      profile: multi,
      publication_id: '019b76da-cb28-7003-8000-0000000000a1',
      published_at_utc: '2026-01-01T00:00:09.000Z',
      segments: [[raw(1, PING), raw(2, tick('SYNTH_100')), raw(3, UNATTRIBUTABLE)]],
    });
    expect(publication.core).toMatchObject({
      incident_count: 1,
      incident_schema_version: '2.0.0',
      normalized_tick_count: 1,
      normalizer_version: '1.1.0',
      quality_rule_version: '1.1.0',
      raw_frame_count: 3,
      symbols: ['SYNTH_100'],
    });
  });

  it('un dataset sin ningún símbolo atribuible no es publicable', () => {
    expect(() =>
      buildDatasetPublication({
        locateManifest: () => 's3://buoh-test/manifest',
        locateObject: () => 's3://buoh-test/object',
        profile: multi,
        publication_id: '019b76da-cb28-7003-8000-0000000000a1',
        published_at_utc: '2026-01-01T00:00:09.000Z',
        segments: [[raw(1, PING), raw(2, UNATTRIBUTABLE)]],
      }),
    ).toThrow(/símbolos atribuibles/u);
  });

  it('aplicadas a los source events del vector v1 dan los mismos ticks e incidencias', () => {
    const readNdjson = (file: string) =>
      readFileSync(resolve(vectorRoot, file), 'utf8')
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
    const segments = [
      readNdjson('expected-source-events-000000.ndjson'),
      readNdjson('expected-source-events-000001.ndjson'),
    ];
    const v1 = createPipelineProfile({
      connector_version: 'fixture-v1',
      quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
      source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
      source_schema_release: 'synthetic-v1',
    });
    const quality = JSON.parse(
      readFileSync(resolve(vectorRoot, 'quality-profile.json'), 'utf8'),
    ) as Record<string, unknown>;
    const v11 = createPipelineProfile({
      connector_version: 'fixture-v1',
      quality_profile_bytes: Buffer.from(
        JSON.stringify({ ...quality, quality_rule_version: '1.1.0' }),
      ),
      source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
      source_schema_release: 'synthetic-v1',
    });
    const before = deriveMarketData(segments, v1);
    const after = deriveMarketData(segments, v11);
    expect(after.ticks).toEqual(before.ticks);
    const summary = (items: typeof before.incidents) =>
      items.map((item) => [item.incident_type, item.observed_ref, item.symbol, item.evidence]);
    expect(summary(after.incidents)).toEqual(summary(before.incidents));
    const conditions = (items: typeof before.conditions) =>
      items.map((item) => [
        item.condition_type,
        item.action,
        item.condition_key,
        item.occurred_at_utc,
      ]);
    expect(conditions(after.conditions)).toEqual(conditions(before.conditions));
    expect(after.openConditionTypes).toEqual(before.openConditionTypes);
  });

  it('rechaza un perfil con un conjunto de reglas no implementado', () => {
    expect(() => profileFor('9.9.9' as '1.1.0', ['SYNTH_100'])).toThrow(/no está implementada/u);
  });
});
