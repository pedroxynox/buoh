import type { SocketSignal } from '../../src/deriv/socket.js';
import { DERIV_BATCH_OPERATIONS } from '../../src/deriv/schema-release.js';
import { catalogEntry, FakeDerivSocket, syntheticSchemaArchive } from './deriv-fixtures.js';

// Lo que necesitan las pruebas del comando de los lotes (ADR-0021 §3; precisión del PR 5c1 de su §9):
// el archivo de esquemas sintético con las operaciones de los lotes y un socket que responde solo.

/**
 * Las velas responden con `candles`; el esquema sintético de `ticks_history` lo admite aquí. El de
 * `contracts_for` describe sus entradas sin admitir campos ajenos y sin `growth_rate_barrier_offsets`,
 * como la release fijada, para que se note `relaxContractsForResponseSchema`.
 */
export const BATCH_FIXTURE = syntheticSchemaArchive(
  {
    'contracts_for_response.schema.json': {
      $schema: 'http://json-schema.org/draft-04/schema#',
      properties: {
        contracts_for: {
          properties: {
            available: {
              items: {
                additionalProperties: false,
                properties: { contract_type: { type: 'string' } },
                type: 'object',
              },
              type: 'array',
            },
          },
          required: ['available'],
          type: 'object',
        },
        echo_req: { type: 'object' },
        msg_type: { enum: ['contracts_for'], type: 'string' },
        req_id: { type: 'integer' },
      },
      required: ['echo_req', 'msg_type'],
      type: 'object',
    },
    'ticks_history_response.schema.json': {
      $schema: 'http://json-schema.org/draft-04/schema#',
      properties: {
        echo_req: { type: 'object' },
        msg_type: { enum: ['candles', 'history', 'ticks_history'], type: 'string' },
        req_id: { type: 'integer' },
      },
      required: ['echo_req', 'msg_type'],
      type: 'object',
    },
  },
  DERIV_BATCH_OPERATIONS,
);

export type Respond = (
  request: Record<string, unknown>,
  index: number,
) => Record<string, unknown> | null;

/** La respuesta válida de cada petición de los lotes, con su eco. */
export const answer: Respond = (request) => {
  const { req_id: reqId, ...echo } = request;
  const base = { echo_req: { ...echo, req_id: reqId }, req_id: reqId };
  if ('active_symbols' in request) {
    return {
      ...base,
      active_symbols: [catalogEntry('R_100', 'Volatility 100')],
      msg_type: 'active_symbols',
    };
  }
  if ('contracts_for' in request) {
    return { ...base, contracts_for: { available: [] }, msg_type: 'contracts_for' };
  }
  if ('proposal' in request) {
    return { ...base, msg_type: 'proposal', proposal: { ask_price: 10, id: 'p' } };
  }
  if ('ticks_history' in request) {
    return { ...base, candles: [], msg_type: 'candles' };
  }
  return { ...base, msg_type: 'trading_times', trading_times: { markets: [] } };
};

/** Un socket que se abre solo y responde a cada petición en cuanto llega. */
export class AnsweringSocket extends FakeDerivSocket {
  readonly #respond: Respond;
  readonly #index: { value: number };

  constructor(
    input: { readonly onSignal: (signal: SocketSignal) => void; readonly url: string },
    respond: Respond,
    index: { value: number },
  ) {
    super(input);
    this.#respond = respond;
    this.#index = index;
    setImmediate(() => {
      this.open();
    });
  }

  override send(text: string): void {
    super.send(text);
    const response = this.#respond(JSON.parse(text) as Record<string, unknown>, this.#index.value);
    this.#index.value += 1;
    if (response !== null) {
      setImmediate(() => {
        this.text(JSON.stringify(response));
      });
    }
  }
}
