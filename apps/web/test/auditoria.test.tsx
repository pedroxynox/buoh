/**
 * Los eventos de datos en la Auditoría de la web servida por la API (`F2-AUDIT-001` y `F2-UI-001`;
 * concepto de interfaz §12): la forma de la respuesta, contrastada con el esquema de
 * `@buoh/contracts`; sus textos; la vista en cada estado, sin controles para cambiar nada; y la
 * lectura de la API, sin el token CSRF. Los eventos son sintéticos, con la forma de los que guardó
 * producción.
 */
import { dataEventsSchema, type DataEvent, type DataEvents } from '@buoh/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EventosDeDatosView,
  type DataEventsState,
} from '../src/components/auditoria/EventosDeDatos';
import { dataEventDetail, dataEventTitle, spanishList } from '../src/components/auditoria/eventos';
import { DATA_EVENTS_LIMIT, readDataEvents } from '../src/components/auditoria/respuesta';
import { AuditoriaReal } from '../src/components/AuditoriaReal';
import { api } from '../src/components/auth/api';

const hex = (digit: string) => digit.repeat(64);

const RESOLVED = {
  kind: 'condition',
  log: 3,
  at_utc: '2026-11-09T14:00:20.511Z',
  source: 'deriv_options',
  condition_event_id: `sha256:${hex('c')}`,
  condition_key: `persistence_unavailable:sha256:${hex('d')}`,
  condition_type: 'persistence_unavailable',
  symbol: null,
  action: 'resolved',
  resolution_reason: 'persistence_restored',
} satisfies DataEvent;
const OPENED = {
  ...RESOLVED,
  at_utc: '2026-11-09T14:00:00.124Z',
  condition_event_id: `sha256:${hex('b')}`,
  action: 'opened',
  resolution_reason: null,
} satisfies DataEvent;
const PERSISTENCE = {
  kind: 'incident',
  log: 3,
  at_utc: '2026-11-09T14:00:00.124Z',
  source: 'deriv_options',
  incident_id: `sha256:${hex('a')}`,
  incident_type: 'persistence_unavailable',
  severity: 'critical',
  symbol: null,
  evidence: { stage: 'raw_object_write', reason: 'ServiceUnavailable' },
} satisfies DataEvent;
const LIMIT = {
  kind: 'incident',
  log: 3,
  at_utc: '2026-11-09T10:00:00.000Z',
  source: 'deriv_options',
  incident_id: `sha256:${hex('9')}`,
  incident_type: 'source_limit_exceeded',
  severity: 'error',
  symbol: 'R_100',
  evidence: {
    resource: 'websocket_frame',
    unit: 'bytes',
    observed_value: 2_000_000,
    maximum_value: 1_048_576,
  },
} satisfies DataEvent;
const RESPONSE = {
  kind: 'incident',
  log: 3,
  at_utc: '2026-11-09T09:00:00.500Z',
  source: 'deriv_options',
  incident_id: `sha256:${hex('8')}`,
  incident_type: 'invalid_source_frame',
  severity: 'error',
  symbol: null,
  evidence: { reason: 'catalog_empty', raw_payload_sha256: hex('7') },
} satisfies DataEvent;
const CATALOG = {
  kind: 'catalog_version',
  log: 3,
  at_utc: '2026-11-09T00:00:06.105Z',
  source: 'deriv_options',
  version: 1,
  snapshot_id: `sha256:${hex('6')}`,
  content_sha256: hex('5'),
  entry_count: 89,
} satisfies DataEvent;
const PUBLICATION = {
  kind: 'publication',
  log: 2,
  at_utc: '2026-11-07T00:00:00.000Z',
  source: 'deriv_options',
  dataset_id: `sha256:${hex('4')}`,
  publication_id: '01900000-0000-7000-8000-000000000042',
  state: 'active',
} satisfies DataEvent;

const EVENTS: DataEvents = {
  logs: [4, 3, 2],
  events: [RESOLVED, OPENED, PERSISTENCE, LIMIT, RESPONSE, CATALOG, PUBLICATION],
  truncated: false,
};

describe('la respuesta de los eventos de datos, como el contrato', () => {
  const samples: unknown[] = [
    EVENTS,
    { logs: [], events: [], truncated: false },
    { logs: [4, 3], events: [], truncated: false },
    {
      logs: [3],
      events: Array.from({ length: DATA_EVENTS_LIMIT }, () => CATALOG),
      truncated: true,
    },
    // Una publicación de un log que ya no se lee: los datasets no vencen (ADR-0020 §10).
    { logs: [4], events: [{ ...PUBLICATION, log: 1 }], truncated: false },
    { logs: [], events: [{ ...PUBLICATION, log: 1 }], truncated: false },
  ];

  it('acepta lo que acepta el esquema', () => {
    for (const sample of samples) {
      expect(dataEventsSchema.safeParse(sample).success).toBe(true);
      expect(readDataEvents(sample)).toEqual(sample);
    }
  });

  it('el mayor número de log es el del contrato', () => {
    for (const log of [999_999, 1_000_000]) {
      const value = { logs: [log], events: [{ ...CATALOG, log }], truncated: false };
      expect(readDataEvents(value) !== null, String(log)).toBe(
        dataEventsSchema.safeParse(value).success,
      );
    }
    expect(readDataEvents({ logs: [999_999], events: [], truncated: false })).not.toBeNull();
  });

  it('rechaza, como el esquema, cada regla entre campos', () => {
    const invalid: unknown[] = [
      // Del más viejo al más nuevo.
      { ...EVENTS, events: [...EVENTS.events].reverse() },
      // Un evento que no es una publicación, de un log que no se leyó.
      { ...EVENTS, logs: [4] },
      { logs: [4], events: [{ ...CATALOG, log: 1 }], truncated: false },
      // Los logs sin orden, o repetidos.
      { ...EVENTS, logs: [2, 3, 4] },
      { ...EVENTS, logs: [4, 3, 3, 2] },
      // Una lista cortada que no está llena, o más larga que el límite.
      { ...EVENTS, truncated: true },
      {
        logs: [3],
        events: Array.from({ length: DATA_EVENTS_LIMIT + 1 }, () => CATALOG),
        truncated: true,
      },
      {
        logs: [3],
        events: Array.from({ length: DATA_EVENTS_LIMIT + 1 }, () => CATALOG),
        truncated: false,
      },
      // Una apertura con motivo, una resolución sin él, o la clave de otro tipo.
      { ...EVENTS, events: [{ ...OPENED, resolution_reason: 'persistence_restored' }] },
      { ...EVENTS, events: [{ ...RESOLVED, resolution_reason: null }] },
      {
        ...EVENTS,
        events: [{ ...OPENED, condition_key: `source_limit_exceeded:sha256:${hex('d')}` }],
      },
      // Un motivo que no es un código, una clase o un tipo que no existen, un campo de más.
      {
        ...EVENTS,
        events: [
          { ...PERSISTENCE, evidence: { stage: 'raw_object_write', reason: 'con espacio' } },
        ],
      },
      { ...EVENTS, events: [{ ...CATALOG, kind: 'otra' }] },
      { ...EVENTS, events: [{ ...PERSISTENCE, incident_type: 'duplicate_exact' }] },
      { ...EVENTS, events: [{ ...PUBLICATION, extra: 1 }] },
      { ...EVENTS, extra: 1 },
    ];
    for (const value of invalid) {
      expect(dataEventsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
      expect(readDataEvents(value), JSON.stringify(value)).toBeNull();
    }
  });

  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const POOL: unknown[] = [
    null,
    0,
    -1,
    1,
    2,
    1.5,
    5,
    '',
    'x',
    'R_100',
    true,
    false,
    [],
    {},
    '2026-11-09T14:00:00.124Z',
    '2026-11-10T00:00:00.000Z',
    '2026-11-09T14:00:00Z',
    'deriv_options',
    'opened',
    'resolved',
    'incident',
    'condition',
    'catalog_version',
    'publication',
    'persistence_unavailable',
    'source_limit_exceeded',
    'invalid_source_frame',
    'connection_lost',
    'raw_object_write',
    'websocket_frame',
    'bytes',
    'critical',
    'active',
    'superseded',
    'persistence_restored',
    `sha256:${hex('e')}`,
    hex('e'),
    `persistence_unavailable:sha256:${hex('e')}`,
    '01900000-0000-7000-8000-000000000099',
    999_999,
    1_000_000,
  ];

  /** Cambia una cosa al azar: borra, añade o reemplaza un campo, o reordena una lista. */
  function mutate(value: unknown, random: () => number): unknown {
    const copy = structuredClone(value);
    const holders: (Record<string, unknown> | unknown[])[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        holders.push(node);
        node.forEach(walk);
      } else if (typeof node === 'object' && node !== null) {
        holders.push(node as Record<string, unknown>);
        Object.values(node).forEach(walk);
      }
    };
    walk(copy);
    const holder = holders[Math.floor(random() * holders.length)];
    const pick = POOL[Math.floor(random() * POOL.length)];
    if (holder === undefined) {
      return pick;
    }
    if (Array.isArray(holder)) {
      const choice = random();
      if (holder.length > 0 && choice < 0.3) {
        holder.splice(Math.floor(random() * holder.length), 1);
      } else if (holder.length > 0 && choice < 0.6) {
        holder.push(structuredClone(holder[Math.floor(random() * holder.length)]));
      } else if (choice < 0.8) {
        holder.reverse();
      } else {
        holder[Math.floor(random() * Math.max(holder.length, 1))] = pick;
      }
      return copy;
    }
    const keys = Object.keys(holder);
    const choice = random();
    const key = keys[Math.floor(random() * keys.length)];
    if (key !== undefined && choice < 0.2) {
      Reflect.deleteProperty(holder, key);
    } else if (choice < 0.3) {
      holder.extra = pick;
    } else if (key !== undefined) {
      holder[key] = pick;
    }
    return copy;
  }

  it('da lo mismo que el esquema en miles de respuestas cambiadas al azar', () => {
    const random = seeded(2026);
    let accepted = 0;
    for (let round = 0; round < 4000; round += 1) {
      const base = samples[round % samples.length];
      const value = mutate(round % 5 === 0 ? mutate(base, random) : base, random);
      const expected = dataEventsSchema.safeParse(value).success;
      expect(readDataEvents(value) !== null, JSON.stringify(value).slice(0, 2000)).toBe(expected);
      accepted += expected ? 1 : 0;
    }
    // Las mutaciones no son todas inválidas: también prueban lo que se acepta.
    expect(accepted).toBeGreaterThan(100);
    // Con los demás paquetes a la vez, en `verify:pr`, tardó 5,4 s: más que el plazo de 5 s.
  }, 30_000);
});

describe('los textos de cada evento', () => {
  it('dicen qué pasó con los valores del registro', () => {
    expect([dataEventTitle(PERSISTENCE), dataEventDetail(PERSISTENCE)]).toEqual([
      'Persistencia no disponible',
      'No se pudo guardar el mensaje de Deriv en el almacenamiento: ServiceUnavailable',
    ]);
    expect([dataEventTitle(OPENED), dataEventDetail(OPENED)]).toEqual([
      'Condición abierta: Persistencia no disponible',
      'Mientras siga abierta, la salud no es «Saludable»',
    ]);
    expect([dataEventTitle(RESOLVED), dataEventDetail(RESOLVED)]).toEqual([
      'Condición resuelta: Persistencia no disponible',
      'La escritura volvió a confirmarse',
    ]);
    expect([dataEventTitle(LIMIT), dataEventDetail(LIMIT)]).toEqual([
      'Límite de fuente superado',
      'Mensaje de Deriv: 2000000 bytes, con un máximo de 1048576 · R_100',
    ]);
    expect([dataEventTitle(RESPONSE), dataEventDetail(RESPONSE)]).toEqual([
      'Respuesta de Deriv no válida',
      'El catálogo llegó vacío',
    ]);
    expect([dataEventTitle(CATALOG), dataEventDetail(CATALOG)]).toEqual([
      'Versión 1 del catálogo',
      `89 instrumentos · contenido ${hex('5').slice(0, 12)}…`,
    ]);
    expect([dataEventTitle(PUBLICATION), dataEventDetail(PUBLICATION)]).toEqual([
      'Dataset publicado',
      `sha256:${hex('4').slice(0, 12)}… · activo`,
    ]);
  });

  it('un motivo que la web no conoce se muestra con su código', () => {
    expect(
      dataEventDetail({
        ...RESPONSE,
        evidence: { ...RESPONSE.evidence, reason: 'motivo_nuevo' },
      }),
    ).toBe('motivo_nuevo');
    expect(dataEventDetail({ ...RESOLVED, resolution_reason: 'otro_motivo' })).toBe('otro_motivo');
  });

  it('las listas de logs, en español', () => {
    expect([
      spanishList([]),
      spanishList([4]),
      spanishList([4, 3]),
      spanishList([4, 3, 2]),
    ]).toEqual(['', '4', '4 y 3', '4, 3 y 2']);
  });
});

describe('la vista de los eventos de datos', () => {
  const render = (state: DataEventsState) =>
    renderToStaticMarkup(<EventosDeDatosView state={state} />);

  it('con eventos: una fila por evento, la gravedad de las incidencias, los logs leídos y cuánto se guardan', () => {
    const html = render({ kind: 'ready', data: EVENTS });
    expect(html.match(/<tr>/gu)?.length).toBe(EVENTS.events.length + 1);
    expect(html).toContain('Condición resuelta: Persistencia no disponible');
    expect(html).toContain('ServiceUnavailable');
    expect(html).toContain('9 nov 2026, 14:00:00 UTC');
    expect(html).toContain('Severidad');
    expect(html).toContain('Se leyeron los logs 4, 3 y 2.');
    expect(html).toContain('se borra con él, a los 30 días de su última escritura');
    expect(html).toContain('Las publicaciones de los datasets no vencen');
    expect(html).not.toContain('más recientes');
    // Solo muestra: ningún control para cambiar nada, y ningún dato ficticio.
    expect(html).not.toMatch(/<button|<input|<form/u);
    expect(html).not.toContain('Datos ficticios');
  });

  it('con la lista cortada, lo dice', () => {
    const html = render({
      kind: 'ready',
      data: {
        logs: [3],
        events: Array.from({ length: DATA_EVENTS_LIMIT }, () => CATALOG),
        truncated: true,
      },
    });
    expect(html).toContain('Se leyó el log 3.');
    expect(html).toContain(`Se muestran los ${String(DATA_EVENTS_LIMIT)} más recientes`);
  });

  it('vacía, dice por qué: sin logs, o con logs sin eventos', () => {
    expect(render({ kind: 'ready', data: { logs: [], events: [], truncated: false } })).toContain(
      'Todavía no hay ningún log de la captura.',
    );
    expect(render({ kind: 'ready', data: { logs: [4], events: [], truncated: false } })).toContain(
      'Los logs guardados no tienen eventos de datos.',
    );
  });

  it('cargando, y con un fallo, su texto fijo y, sin sesión, el enlace para iniciarla', () => {
    expect(render({ kind: 'loading' })).toContain('Cargando los eventos de datos…');
    const failed = render({
      kind: 'error',
      message: 'El servicio no responde.',
      unauthenticated: false,
    });
    expect(failed).toContain('No se pudieron cargar');
    expect(failed).not.toContain('/acceso');
    expect(
      render({ kind: 'error', message: 'Tu sesión no es válida.', unauthenticated: true }),
    ).toContain('href="/acceso"');
  });

  it('la Auditoría real muestra las dos listas, primero las dos cargando', () => {
    const html = renderToStaticMarkup(<AuditoriaReal />);
    expect(html).toContain('Eventos de la cuenta');
    expect(html).toContain('Eventos de datos');
    expect(html).toContain('Cargando la auditoría…');
    expect(html).toContain('Cargando los eventos de datos…');
  });
});

describe('la lectura de los eventos de datos, sin el token CSRF', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown) {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return requests;
  }

  it('GET al mismo origen, sin cuerpo ni token; sin la forma del contrato, «unexpected»', async () => {
    const requests = stubFetch(200, EVENTS);
    await expect(api.dataEvents()).resolves.toEqual(EVENTS);
    expect(requests[0]?.path).toBe('/api/v1/datos/eventos');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/iu);
    expect(requests[0]?.init?.body).toBeUndefined();
    stubFetch(200, { ...EVENTS, logs: [4] });
    await expect(api.dataEvents()).rejects.toMatchObject({ failure: { code: 'unexpected' } });
  });

  it('un error llega con su código', async () => {
    stubFetch(401, {
      error: { code: 'unauthenticated', request_id: '7c2a4f9e-1f5b-4c3d-9a8e-2b6d0f1e3a5c' },
    });
    await expect(api.dataEvents()).rejects.toMatchObject({
      failure: { code: 'unauthenticated' },
    });
  });
});
