import { sha256Hex } from '@buoh/contracts';
import { expect, it } from 'vitest';

import {
  type ClosedSourceSegment,
  type SourceEventIndexRow,
  type SourceLogStore,
  type StoredLiveCheckpoint,
} from '../../src/source-log/ports.js';

// Las reglas del almacén de los puntos de control del estado vivo (migración `0005`, ADR-0017 §5 y
// §6), comunes al de memoria y al de PostgreSQL: así los dos aceptan y rechazan lo mismo. Cada
// prueba usa sus propias fuentes, porque el de PostgreSQL comparte sus tablas entre pruebas. Las
// filas son sintéticas: el almacén no interpreta el JCS, lo comprueba quien lo lee
// (`checkStoredCheckpoint`).

/** SHA-256 de las versiones de las filas por defecto, y el de otras versiones. */
export const VERSIONS_SHA256 = 'a'.repeat(64);
export const OTHER_VERSIONS_SHA256 = 'b'.repeat(64);

/** Un UUID determinista para cada fuente, segmento y posición, único en toda la tabla. */
function eventId(source: string, segmentIndex: number, position: number): string {
  const hex = sha256Hex(`${source}/${String(segmentIndex)}/${String(position)}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** El `logical_content_sha256` sintético del segmento `segmentIndex` de la fuente. */
export function logicalSha256(source: string, segmentIndex: number): string {
  return sha256Hex(`logical/${source}/${String(segmentIndex)}`);
}

/**
 * Cierra los segmentos 0 a `count` − 1 de la fuente en el índice: cada uno con dos raw frames y un
 * evento de conexión, y el `logical_content_sha256` de `logicalSha256`. Sin objetos: el almacén del
 * índice no los lee.
 */
export async function closeSegments(
  store: SourceLogStore,
  source: string,
  count: number,
): Promise<void> {
  for (let segmentIndex = 0; segmentIndex < count; segmentIndex += 1) {
    const kinds: SourceEventIndexRow['kind'][] = [
      'connection_opened',
      'raw_source_frame',
      'raw_source_frame',
    ];
    for (const [position, kind] of kinds.entries()) {
      await store.insertIndexRow({
        byte_length: 100,
        event_id: eventId(source, segmentIndex, position),
        event_time_utc: '2026-03-02T10:00:00.000Z',
        kind,
        object_sha256: sha256Hex(`object/${eventId(source, segmentIndex, position)}`),
        position,
        segment_index: segmentIndex,
        source,
      });
    }
    const segment: ClosedSourceSegment = {
      byte_count: 300,
      close_reason: 'window',
      compression: 'none',
      event_count: 3,
      first_event_time_utc: '2026-03-02T10:00:00.000Z',
      last_event_time_utc: '2026-03-02T10:04:59.000Z',
      logical_content_sha256: logicalSha256(source, segmentIndex),
      object_bytes_sha256: logicalSha256(source, segmentIndex),
      object_size_bytes: 300,
      raw_frame_count: 2,
      segment_index: segmentIndex,
      segment_policy_version: '1.0.0',
      source,
      writer_name: null,
      writer_version: null,
    };
    await store.insertClosedSegment(segment);
  }
}

/**
 * Una fila del punto de control del segmento `segmentIndex`, enlazada con los segmentos de
 * `closeSegments`: tres eventos y dos raw frames por segmento. Su `checkpoint_sha256` es el de su
 * JCS, salvo que se dé otro.
 */
export function storedCheckpointOf(
  source: string,
  segmentIndex: number,
  overrides: Partial<StoredLiveCheckpoint> = {},
): StoredLiveCheckpoint {
  const jcs =
    overrides.checkpoint_jcs ??
    `{"segment_index":${String(segmentIndex)},"source":${JSON.stringify(source)}}`;
  return {
    checkpoint_sha256: sha256Hex(jcs),
    connector_version: 'deriv-options-ws-1.1.0',
    event_count: 3 * (segmentIndex + 1),
    live_state_version: '1.0.0',
    quality_profile_sha256: 'c'.repeat(64),
    quality_rule_version: '2.0.0',
    raw_frame_count: 2 * (segmentIndex + 1),
    schema_version: '1.0.0',
    segment_index: segmentIndex,
    segment_logical_content_sha256: logicalSha256(source, segmentIndex),
    segment_policy_version: '1.0.0',
    source,
    source_event_schema_version: '1.0.0',
    source_schema_sha256: 'd'.repeat(64),
    symbol: 'SYNTH_100',
    versions_sha256: VERSIONS_SHA256,
    written_at_utc: '2026-03-02T10:05:00.000Z',
    ...overrides,
    checkpoint_jcs: jcs,
  };
}

/**
 * Las pruebas comunes de la búsqueda de un evento en el índice (`hasSourceEvent`), con la que el
 * arranque comprueba `cursor_ahead_of_log` (ADR-0017 §4); `open` da el almacén de cada prueba.
 */
export function sourceEventLookupRules(open: () => SourceLogStore): void {
  it('hasSourceEvent encuentra un evento de un segmento cerrado y del abierto, y solo en su fuente', async () => {
    const store = open();
    const source = 'rules_lookup';
    await closeSegments(store, source, 1);
    const openId = eventId(source, 1, 0);
    await store.insertIndexRow({
      byte_length: 100,
      event_id: openId,
      event_time_utc: '2026-03-02T10:05:00.000Z',
      kind: 'raw_source_frame',
      object_sha256: sha256Hex(`object/${openId}`),
      position: 0,
      segment_index: 1,
      source,
    });

    expect(await store.hasSourceEvent(source, eventId(source, 0, 0))).toBe(true);
    expect(await store.hasSourceEvent(source, eventId(source, 0, 2))).toBe(true);
    expect(await store.hasSourceEvent(source, openId)).toBe(true);
    expect(await store.hasSourceEvent(source, eventId(source, 1, 1))).toBe(false);
    expect(await store.hasSourceEvent('rules_lookup_other', openId)).toBe(false);
  });

  it('hasSourceEvent compara el ID como texto: en mayúsculas, sin guiones o sin ser un UUID, no lo encuentra', async () => {
    const store = open();
    const source = 'rules_lookup_text';
    await closeSegments(store, source, 1);
    const id = eventId(source, 0, 1);

    expect(await store.hasSourceEvent(source, id)).toBe(true);
    for (const other of [id.toUpperCase(), id.replaceAll('-', ''), `{${id}}`, 'no-es-un-uuid']) {
      expect(await store.hasSourceEvent(source, other), other).toBe(false);
    }
  });
}

/** Define las pruebas comunes; `open` da el almacén de cada prueba. */
export function checkpointStoreRules(open: () => SourceLogStore): void {
  it('sin puntos de control de la fuente y esas versiones, readLiveCheckpoint da null', async () => {
    const store = open();
    expect(await store.readLiveCheckpoint('rules_cp_empty', VERSIONS_SHA256, null)).toBeNull();
    await store.insertLiveCheckpoint(storedCheckpointOf('rules_cp_empty', 0));
    expect(
      await store.readLiveCheckpoint('rules_cp_empty', OTHER_VERSIONS_SHA256, null),
    ).toBeNull();
    expect(
      await store.readLiveCheckpoint('rules_cp_empty_other', VERSIONS_SHA256, null),
    ).toBeNull();
  });

  it('inserta una vez: la misma fila da exists, también con otra hora, y otro SHA-256 en la misma clave da conflict sin cambiar la guardada', async () => {
    const store = open();
    const source = 'rules_cp_key';
    await closeSegments(store, source, 1);
    const row = storedCheckpointOf(source, 0);
    expect(await store.insertLiveCheckpoint(row)).toBe('inserted');
    expect(await store.insertLiveCheckpoint(row)).toBe('exists');
    expect(
      await store.insertLiveCheckpoint({ ...row, written_at_utc: '2026-03-02T11:00:00.000Z' }),
    ).toBe('exists');
    const other = storedCheckpointOf(source, 0, { checkpoint_jcs: '{"otro":true}' });
    expect(await store.insertLiveCheckpoint(other)).toBe('conflict');
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, null))?.row).toEqual(row);
  });

  it('las filas de otras versiones del mismo segmento conviven, y cada lectura solo ve las suyas', async () => {
    const store = open();
    const source = 'rules_cp_versions';
    await closeSegments(store, source, 1);
    const row = storedCheckpointOf(source, 0);
    const other = storedCheckpointOf(source, 0, {
      checkpoint_jcs: '{"version":"otra"}',
      live_state_version: '2.0.0',
      versions_sha256: OTHER_VERSIONS_SHA256,
    });
    expect(await store.insertLiveCheckpoint(row)).toBe('inserted');
    expect(await store.insertLiveCheckpoint(other)).toBe('inserted');
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, null))?.row).toEqual(row);
    expect((await store.readLiveCheckpoint(source, OTHER_VERSIONS_SHA256, null))?.row).toEqual(
      other,
    );
  });

  it('readLiveCheckpoint da el de mayor segmento, o el mayor por debajo de below, con cada columna como se guardó', async () => {
    const store = open();
    const source = 'rules_cp_latest';
    await closeSegments(store, source, 3);
    const rows = [0, 1, 2].map((segmentIndex) => storedCheckpointOf(source, segmentIndex));
    // En otro orden que el de los segmentos.
    for (const row of [rows[1], rows[0], rows[2]]) {
      if (row !== undefined) {
        await store.insertLiveCheckpoint(row);
      }
    }
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, null))?.row).toEqual(rows[2]);
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, 2))?.row).toEqual(rows[1]);
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, 1))?.row).toEqual(rows[0]);
    expect(await store.readLiveCheckpoint(source, VERSIONS_SHA256, 0)).toBeNull();
  });

  it('el enlace sale de closed_source_segments: el hash lógico del segmento k y las sumas de los segmentos 0 a k', async () => {
    const store = open();
    const source = 'rules_cp_binding';
    await closeSegments(store, source, 2);
    await store.insertLiveCheckpoint(storedCheckpointOf(source, 1));
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, null))?.binding).toEqual({
      event_count: 6,
      logical_content_sha256: logicalSha256(source, 1),
      raw_frame_count: 4,
    });
    // Uno de un segmento que no está cerrado: sin hash lógico, con las sumas de los cerrados.
    await store.insertLiveCheckpoint(storedCheckpointOf(source, 4));
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, null))?.binding).toEqual({
      event_count: 6,
      logical_content_sha256: null,
      raw_frame_count: 4,
    });
    // Uno por debajo del último segmento cerrado: las sumas paran en su segmento.
    await store.insertLiveCheckpoint(storedCheckpointOf(source, 0));
    expect((await store.readLiveCheckpoint(source, VERSIONS_SHA256, 1))?.binding).toEqual({
      event_count: 3,
      logical_content_sha256: logicalSha256(source, 0),
      raw_frame_count: 2,
    });
    // Sin ningún segmento cerrado de la fuente.
    await store.insertLiveCheckpoint(storedCheckpointOf('rules_cp_binding_none', 0));
    expect(
      (await store.readLiveCheckpoint('rules_cp_binding_none', VERSIONS_SHA256, null))?.binding,
    ).toEqual({ event_count: 0, logical_content_sha256: null, raw_frame_count: 0 });
  });
}
