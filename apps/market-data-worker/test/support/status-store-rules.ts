import { type IngestionCursor } from '@buoh/contracts';
import { expect, it } from 'vitest';

import { type IngestionHeartbeat, type IngestionStatusStore } from '../../src/ingestion/status.js';

// Las reglas de los almacenes del cursor y del latido (ADR-0015 §6), comunes al de memoria y al de
// PostgreSQL: así los dos aceptan y rechazan lo mismo. Cada prueba usa sus propias fuentes, porque
// el de PostgreSQL comparte las tablas de la migración `0004` entre pruebas.

export function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

export function cursorOf(
  source: string,
  overrides: Partial<IngestionCursor> = {},
): IngestionCursor {
  return {
    active_segment_index: 0,
    connection_id: uuid(1),
    high_watermark_event_time_utc: '2026-03-02T10:00:01.000Z',
    last_durable_observation_id: uuid(3),
    last_durable_source_event_id: uuid(4),
    schema_version: '1.0.0',
    source,
    source_event_count: 4,
    symbol: 'SYNTH_100',
    updated_at_utc: '2026-03-02T10:00:02.000Z',
    ...overrides,
  };
}

export function heartbeatOf(
  source: string,
  sequence: number,
  overrides: Partial<IngestionHeartbeat> = {},
): IngestionHeartbeat {
  return {
    backlog_bytes: 0,
    backlog_count: 0,
    connection_state: 'connecting',
    heartbeat_id: uuid(1000 + sequence),
    observed_at_utc: '2026-03-02T10:00:00.000Z',
    pg_backend_pid: 4242,
    run_id: uuid(500),
    source,
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'sin error',
    (error: unknown) => error,
  );
}

/** Define las pruebas comunes; `open` da el almacén de cada prueba. */
export function statusStoreRules(open: () => IngestionStatusStore): void {
  it('sin cursores ni latidos, latestCursor y latestHeartbeat dan null', async () => {
    const store = open();
    expect(await store.latestCursor('rules_empty', 'SYNTH_100')).toBeNull();
    expect(await store.latestHeartbeat('rules_empty')).toBeNull();
  });

  it('numera las versiones del cursor desde 1 por fuente y símbolo, y latestCursor da la última', async () => {
    const store = open();
    const first = cursorOf('rules_versions');
    const second = cursorOf('rules_versions', {
      source_event_count: 9,
      updated_at_utc: '2026-03-02T10:05:00.000Z',
    });
    // Igual que el segundo salvo la hora: también es una versión nueva.
    const third = { ...second, updated_at_utc: '2026-03-02T10:06:00.000Z' };
    const otherSymbol = cursorOf('rules_versions', { symbol: 'SYNTH_50' });
    const otherSource = cursorOf('rules_versions_other');

    expect(await store.appendCursor(first)).toEqual({ cursor: first, version: 1 });
    expect(await store.appendCursor(second)).toEqual({ cursor: second, version: 2 });
    expect(await store.appendCursor(otherSymbol)).toEqual({ cursor: otherSymbol, version: 1 });
    expect(await store.appendCursor(otherSource)).toEqual({ cursor: otherSource, version: 1 });
    expect(await store.appendCursor(third)).toEqual({ cursor: third, version: 3 });

    expect(await store.latestCursor('rules_versions', 'SYNTH_100')).toEqual({
      cursor: third,
      version: 3,
    });
    expect(await store.latestCursor('rules_versions', 'SYNTH_50')).toEqual({
      cursor: otherSymbol,
      version: 1,
    });
    expect(await store.latestCursor('rules_versions_other', 'SYNTH_100')).toEqual({
      cursor: otherSource,
      version: 1,
    });
    expect(await store.latestCursor('rules_versions', 'SYNTH_10')).toBeNull();
  });

  it('cursorSymbols da los símbolos que tienen algún cursor de la fuente, ordenados y sin repetir', async () => {
    const store = open();
    expect(await store.cursorSymbols('rules_symbols')).toEqual([]);
    await store.appendCursor(cursorOf('rules_symbols', { symbol: 'SYNTH_50' }));
    await store.appendCursor(cursorOf('rules_symbols'));
    await store.appendCursor(
      cursorOf('rules_symbols', { source_event_count: 9, symbol: 'SYNTH_50' }),
    );
    await store.appendCursor(cursorOf('rules_symbols_other', { symbol: 'SYNTH_10' }));

    expect(await store.cursorSymbols('rules_symbols')).toEqual(['SYNTH_100', 'SYNTH_50']);
    expect(await store.cursorSymbols('rules_symbols_other')).toEqual(['SYNTH_10']);
  });

  it('guarda los campos nulos del cursor', async () => {
    const store = open();
    const empty = cursorOf('rules_nulls', {
      high_watermark_event_time_utc: null,
      last_durable_observation_id: null,
      source_event_count: 1,
    });
    await store.appendCursor(empty);
    expect(await store.latestCursor('rules_nulls', 'SYNTH_100')).toEqual({
      cursor: empty,
      version: 1,
    });
  });

  it('appendCursor solo guarda un IngestionCursor 1.0.0 válido', async () => {
    const store = open();
    const valid = cursorOf('rules_invalid_cursor');
    const withoutSymbol: Record<string, unknown> = { ...valid };
    delete withoutSymbol['symbol'];
    const invalid: unknown[] = [
      withoutSymbol,
      { ...valid, extra: true },
      { ...valid, schema_version: '1.1.0' },
      { ...valid, symbol: '' },
      { ...valid, connection_id: '019b76da-a800-4000-8000-000000000001' },
      { ...valid, last_durable_source_event_id: null },
      { ...valid, active_segment_index: -1 },
      { ...valid, source_event_count: 1.5 },
      { ...valid, updated_at_utc: '2026-03-02T10:00:02Z' },
      { ...valid, high_watermark_event_time_utc: '2026-02-30T10:00:00.000Z' },
    ];
    for (const input of invalid) {
      expect(await rejectionOf(store.appendCursor(input as IngestionCursor))).toBeInstanceOf(Error);
    }
    expect(await store.latestCursor('rules_invalid_cursor', 'SYNTH_100')).toBeNull();
    // El primer cursor válido sigue siendo la versión 1.
    expect((await store.appendCursor(valid)).version).toBe(1);
  });

  it('latestHeartbeat da el último latido escrito de la fuente, aunque su hora sea anterior', async () => {
    const store = open();
    const start = heartbeatOf('rules_latest', 1);
    const connected = heartbeatOf('rules_latest', 2, {
      backlog_bytes: 512,
      backlog_count: 3,
      connection_state: 'connected',
      observed_at_utc: '2026-03-02T10:00:05.000Z',
    });
    const other = heartbeatOf('rules_latest_other', 3, {
      observed_at_utc: '2026-03-02T10:00:09.000Z',
    });
    // Un reloj que retrocede: el último escrito sigue siendo el último.
    const behind = heartbeatOf('rules_latest', 4, {
      connection_state: 'disconnected',
      observed_at_utc: '2026-03-02T10:00:04.000Z',
    });
    await store.appendHeartbeat(start);
    expect(await store.latestHeartbeat('rules_latest')).toEqual(start);
    await store.appendHeartbeat(connected);
    await store.appendHeartbeat(other);
    expect(await store.latestHeartbeat('rules_latest')).toEqual(connected);
    await store.appendHeartbeat(behind);
    expect(await store.latestHeartbeat('rules_latest')).toEqual(behind);
    expect(await store.latestHeartbeat('rules_latest_other')).toEqual(other);
  });

  it('appendHeartbeat solo guarda un latido válido', async () => {
    const store = open();
    const valid = heartbeatOf('rules_invalid_heartbeat', 10);
    const withoutPid: Record<string, unknown> = { ...valid };
    delete withoutPid['pg_backend_pid'];
    const invalid: unknown[] = [
      withoutPid,
      { ...valid, extra: true },
      { ...valid, connection_state: 'paused' },
      { ...valid, backlog_count: -1 },
      { ...valid, backlog_bytes: -1 },
      { ...valid, backlog_bytes: 0.5 },
      { ...valid, pg_backend_pid: 0 },
      { ...valid, pg_backend_pid: 2_147_483_648 },
      { ...valid, run_id: '019b76da-a800-4000-8000-000000000500' },
      { ...valid, heartbeat_id: 'latido' },
      { ...valid, observed_at_utc: '2026-03-02 10:00:00.000Z' },
      { ...valid, source: '' },
    ];
    for (const input of invalid) {
      expect(await rejectionOf(store.appendHeartbeat(input as IngestionHeartbeat))).toBeInstanceOf(
        Error,
      );
    }
    expect(await store.latestHeartbeat('rules_invalid_heartbeat')).toBeNull();
    await store.appendHeartbeat({ ...valid, pg_backend_pid: 2_147_483_647 });
    expect((await store.latestHeartbeat('rules_invalid_heartbeat'))?.pg_backend_pid).toBe(
      2_147_483_647,
    );
  });

  it('no guarda dos veces el mismo heartbeat_id, como su clave primaria', async () => {
    const store = open();
    const first = heartbeatOf('rules_duplicate', 20);
    await store.appendHeartbeat(first);
    const again = { ...first, connection_state: 'connected' as const };
    expect(((await rejectionOf(store.appendHeartbeat(again))) as { code?: unknown }).code).toBe(
      '23505',
    );
    expect(await store.latestHeartbeat('rules_duplicate')).toEqual(first);
  });
}
