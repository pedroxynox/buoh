import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  connectionClosedSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  rawSourceFrameSchema,
  sha256Hex,
  type SourceEvent,
} from '@buoh/contracts';
import { createPipelineProfile } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import { publishDataset, replayDataset } from '../src/index.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// El replay conserva el lector y la recomputación de las reglas 3.0.0 (ADR-0020 §2): un dataset con
// ticks de la historia y con sus artefactos derivados por partes (§3 y §7) se reproduce en los dos
// modos con el mismo `dataset_id`. Sin red, reloj real ni aleatoriedad. Fuente `synthetic`.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const T0 = 1767225600;
const SYMBOL = 'SYNTH_100';
const A = '019b76da-a800-7000-8000-00000000a000';
const B = '019b76da-a800-7000-8000-00000000b000';

const profile = createPipelineProfile({
  connector_version: 'fixture-v1',
  quality_profile_bytes: Buffer.from(
    JSON.stringify({
      allowed_symbols: [SYMBOL],
      gap_detection: 'after_reconnection',
      maximum_delivery_delay_ms: 3000,
      maximum_event_gap_ms: 2000,
      non_tick_msg_types: ['history', 'ping'],
      profile_id: 'synthetic-publication-3.0.0',
      quality_rule_version: '3.0.0',
      source: 'synthetic',
    }),
  ),
  source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
  source_schema_release: 'synthetic-v1',
});

const id = (sequence: number) => `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
const at = (second: number, milliseconds = 0) =>
  new Date((T0 + second) * 1000 + milliseconds).toISOString();

function raw(sequence: number, conn: string, payload: string, receivedAt: string): SourceEvent {
  return rawSourceFrameSchema.parse({
    connection_id: conn,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: id(sequence),
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: receivedAt,
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

const tick = (sequence: number, conn: string, second: number) =>
  raw(
    sequence,
    conn,
    `{"msg_type":"tick","tick":{"epoch":${String(T0 + second)},"pip_size":3,"quote":100.125,"symbol":"${SYMBOL}"}}`,
    at(second, 100),
  );

/**
 * 5001 ticks del flujo, cada uno dos veces, y después una reconexión con un hueco de 4 s que la
 * historia recupera: 10 005 ticks en tres partes y 5001 duplicados en dos.
 */
function segments(): SourceEvent[][] {
  const stream: SourceEvent[] = [
    connectionOpenedSchema.parse({
      connection_id: A,
      event_id: id(1),
      kind: 'connection_opened',
      occurred_at_utc: at(-1),
      schema_version: '1.0.0',
      source: 'synthetic',
      supersedes_connection_id: null,
    }),
  ];
  let sequence = 2;
  for (let index = 0; index < 5001; index += 1) {
    stream.push(tick(sequence, A, index * 2), tick(sequence + 1, A, index * 2));
    sequence += 2;
  }
  const last = 5000 * 2;
  const history = `{"echo_req":{"count":1000,"end":"${String(T0 + last + 6)}","req_id":3,"start":${String(T0 + last)},"style":"ticks","ticks_history":"${SYMBOL}"},"history":{"prices":[100.125,100.25,100.5,100.125],"times":[${[0, 2, 4, 6].map((offset) => String(T0 + last + offset)).join(',')}]},"msg_type":"history","pip_size":3,"req_id":3}`;
  const reconnection: SourceEvent[] = [
    connectionClosedSchema.parse({
      affected_symbols: [SYMBOL],
      closure_type: 'transport_error',
      connection_id: A,
      event_id: id(sequence),
      kind: 'connection_closed',
      occurred_at_utc: at(last + 1),
      reason: 'close_code_1006',
      schema_version: '1.0.0',
      source: 'synthetic',
    }),
    connectionOpenedSchema.parse({
      connection_id: B,
      event_id: id(sequence + 1),
      kind: 'connection_opened',
      occurred_at_utc: at(last + 5),
      schema_version: '1.0.0',
      source: 'synthetic',
      supersedes_connection_id: A,
    }),
    tick(sequence + 2, B, last + 6),
    raw(sequence + 3, B, history, at(last + 9)),
    historyRecoveryResultSchema.parse({
      connection_id: B,
      event_id: id(sequence + 4),
      from_event_time_utc: at(last, 1),
      kind: 'history_recovery_result',
      occurred_at_utc: at(last + 9, 100),
      recovered_event_count: 2,
      schema_version: '1.0.0',
      source: 'synthetic',
      status: 'complete',
      symbol: SYMBOL,
      to_event_time_utc: at(last + 6, -1),
    }),
  ];
  return [stream, reconnection];
}

describe('replay de un dataset de reglas 3.0.0 (ADR-0020 §2)', { timeout: 60_000 }, () => {
  it('con ticks de la historia y artefactos por partes, se reproduce en los dos modos', async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const publication = await publishDataset({
      environment: 'test',
      metadata,
      objects,
      profile,
      publication_id: '019b76da-cb28-7003-8000-0000000000a1',
      published_at_utc: '2026-01-01T03:00:00.000Z',
      segments: segments(),
      zlibVersion: 'test-zlib',
    });
    const roles = publication.core.logical_artifacts.map((artifact) => artifact.artifact_id);
    expect(roles.filter((artifact) => artifact.startsWith('normalized_ticks'))).toHaveLength(3);
    expect(roles.filter((artifact) => artifact.startsWith('quality_incidents'))).toHaveLength(2);
    expect(
      publication.derived.ticks.filter((item) => item.origin === 'history_recovery'),
    ).toHaveLength(2);

    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId: publication.dataset_id,
        environment: 'test',
        metadata,
        mode,
        objects,
      });
      expect(report).toMatchObject({
        dataset_id: publication.dataset_id,
        normalized_tick_count: 10_005,
        status: mode === 'recompute' ? 'reproduced' : 'verified',
      });
    }
  });
});
