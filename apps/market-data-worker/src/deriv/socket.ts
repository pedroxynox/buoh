import { SOURCE_LIMITS } from '@buoh/domain';
import WebSocket from 'ws';

import { failureReason } from '../source-log/source-event-log.js';

/** Tiempo máximo para abrir la conexión (ADR-0004 §7). */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Lo que el adaptador observa del socket, ya traducido desde `ws`. Los códigos de error son
 * saneados: el `code` o el nombre del error, nunca su mensaje.
 */
export type SocketSignal =
  | { readonly kind: 'open' }
  | { readonly byte_length: number; readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary' }
  /**
   * `ws` cortó un mensaje por `maxPayload`. `observed_value` es la suma de las longitudes declaradas
   * hasta el fragmento que cruzó el límite, o `null` si `ws` no la dejó (ADR-0012 §3).
   */
  | { readonly kind: 'frame_too_large'; readonly observed_value: number | null }
  | { readonly code: string; readonly kind: 'error' }
  | { readonly code: number; readonly kind: 'closed' };

export interface DerivSocket {
  /** Cierre ordenado, con código 1000. */
  close(): void;
  send(text: string): void;
  /** Corta la conexión de inmediato, sin esperar el cierre ordenado. */
  terminate(): void;
}

export type SocketFactory = (input: {
  readonly onSignal: (signal: SocketSignal) => void;
  readonly url: string;
}) => DerivSocket;

/** Opciones de `ws` fijadas en ADR-0012 §3. */
export const WS_CLIENT_OPTIONS = {
  followRedirects: false,
  handshakeTimeout: CONNECT_TIMEOUT_MS,
  maxPayload: SOURCE_LIMITS.websocket_frame.maximum,
  // Sin compresión, las longitudes declaradas son los bytes del mensaje y no hay bombas de
  // descompresión.
  perMessageDeflate: false,
} as const satisfies WebSocket.ClientOptions;

/**
 * Tamaño declarado del mensaje que `ws` cortó. Lee `_receiver._totalPayloadLength`, dos propiedades
 * internas de `ws` 8.22.0, que queda fijada: en un mensaje sin fragmentar es su tamaño, y en uno
 * fragmentado, la suma hasta el fragmento que cruzó el límite. Si faltan o no son un valor mayor que
 * el máximo, devuelve `null`: el adaptador nunca inventa un tamaño.
 */
export function declaredMessageLength(socket: object): number | null {
  const receiver: unknown = Reflect.get(socket, '_receiver');
  if (typeof receiver !== 'object' || receiver === null) {
    return null;
  }
  const total: unknown = Reflect.get(receiver, '_totalPayloadLength');
  return typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total > SOURCE_LIMITS.websocket_frame.maximum
    ? total
    : null;
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/**
 * Transporte real con `ws` (ADR-0012 §3). `ws` comprueba que cada mensaje de texto sea UTF-8 válido
 * antes de entregarlo, así que el texto es exactamente el de los bytes recibidos.
 */
export const openWsSocket: SocketFactory = ({ onSignal, url }) => {
  const socket = new WebSocket(url, WS_CLIENT_OPTIONS);
  socket.on('open', () => {
    onSignal({ kind: 'open' });
  });
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      onSignal({ kind: 'binary' });
      return;
    }
    const bytes = toBuffer(data);
    onSignal({ byte_length: bytes.byteLength, kind: 'text', text: bytes.toString('utf8') });
  });
  socket.on('error', (error) => {
    const code = (error as { code?: unknown }).code;
    if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
      onSignal({ kind: 'frame_too_large', observed_value: declaredMessageLength(socket) });
    } else if (code === 'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH') {
      // Longitud de 64 bits mayor que 2^53 − 1: `ws` no la guarda.
      onSignal({ kind: 'frame_too_large', observed_value: null });
    } else {
      onSignal({ code: failureReason(error), kind: 'error' });
    }
  });
  socket.on('close', (code) => {
    onSignal({ code, kind: 'closed' });
  });
  return {
    close: () => {
      socket.close(1000);
    },
    send: (text) => {
      socket.send(text, (error) => {
        // Node llama al callback sin error, o con `null`, cuando la escritura sale bien.
        if (error) {
          onSignal({ code: failureReason(error), kind: 'error' });
        }
      });
    },
    terminate: () => {
      socket.terminate();
    },
  };
};
