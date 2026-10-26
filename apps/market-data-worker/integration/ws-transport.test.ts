import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { openWsSocket, WS_CLIENT_OPTIONS, type SocketSignal } from '../src/deriv/socket.js';

// Corte de `ws` (ADR-0012 §3 y §11): un servidor local en el mismo proceso comprueba que las
// propiedades internas que lee el adaptador existen en ws 8.22.0 y valen lo declarado, con un
// mensaje entero y con uno fragmentado. Solo usa la interfaz de loopback.
const MIB = 1_048_576;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

async function wsServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', perMessageDeflate: false, port: 0 });
  await once(server, 'listening');
  server.on('connection', onConnection);
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => {
          resolve();
        });
      }),
  );
  return `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** Servidor HTTP propio para respuestas que `ws` nunca enviaría. */
async function rawServer(onUpgrade: (request: IncomingMessage, socket: Socket) => void) {
  const server: Server = createServer();
  server.on('upgrade', onUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** Señales del cliente real hasta su cierre. */
function signalsUntilClosed(url: string): Promise<SocketSignal[]> {
  return new Promise((resolve) => {
    const signals: SocketSignal[] = [];
    openWsSocket({
      onSignal: (signal) => {
        signals.push(signal);
        if (signal.kind === 'closed') {
          resolve(signals);
        }
      },
      url,
    });
  });
}

const kinds = (signals: readonly SocketSignal[]) => signals.map((signal) => signal.kind);

describe('openWsSocket con ws 8.22.0', () => {
  it('entrega un texto de exactamente 1 048 576 bytes y no ofrece compresión', async () => {
    let extensions: string | undefined = 'sin leer';
    const url = await wsServer((socket, request) => {
      extensions = request.headers['sec-websocket-extensions'];
      socket.send('a'.repeat(MIB), () => {
        socket.close(1000);
      });
    });
    const signals = await signalsUntilClosed(url);

    expect(WS_CLIENT_OPTIONS).toEqual({
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: MIB,
      perMessageDeflate: false,
    });
    expect(extensions).toBeUndefined();
    expect(kinds(signals)).toEqual(['open', 'text', 'closed']);
    const text = signals[1];
    expect(
      text?.kind === 'text' ? [text.byte_length, text.text === 'a'.repeat(MIB)] : null,
    ).toEqual([MIB, true]);
  });

  it('corta un mensaje entero de 1 048 577 bytes y da su tamaño declarado', async () => {
    const url = await wsServer((socket) => {
      socket.send('b'.repeat(MIB + 1));
    });
    const signals = await signalsUntilClosed(url);

    expect(kinds(signals)).toEqual(['open', 'frame_too_large', 'closed']);
    expect(signals[1]).toEqual({ kind: 'frame_too_large', observed_value: MIB + 1 });
  });

  it('en un mensaje fragmentado da la suma declarada hasta el fragmento que cruza el límite', async () => {
    const url = await wsServer((socket) => {
      // 500 000 + 600 000 cruzan el límite en el segundo fragmento; el tercero no se lee.
      socket.send('c'.repeat(500_000), { fin: false });
      socket.send('d'.repeat(600_000), { fin: false });
      socket.send('e'.repeat(100_000), { fin: true });
    });
    const signals = await signalsUntilClosed(url);

    expect(kinds(signals)).toEqual(['open', 'frame_too_large', 'closed']);
    expect(signals[1]).toEqual({ kind: 'frame_too_large', observed_value: 1_100_000 });
  });

  it('un mensaje binario llega como binary, sin contenido', async () => {
    const url = await wsServer((socket) => {
      socket.send(Buffer.from([1, 2, 3]), () => {
        socket.close(1000);
      });
    });
    const signals = await signalsUntilClosed(url);

    expect(signals.slice(0, 2)).toEqual([{ kind: 'open' }, { kind: 'binary' }]);
  });

  it('una longitud de 64 bits mayor que 2^53 − 1 no deja tamaño: observed_value es null', async () => {
    const url = await rawServer((request, socket) => {
      const accept = createHash('sha1')
        .update(
          `${String(request.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Frame de texto con FIN y longitud de 64 bits 0xFFFFFFFFFFFFFFFF.
      socket.write(Buffer.from([0x81, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      // El cliente responde con su cierre; se corta la conexión para no esperar su tiempo máximo.
      socket.on('data', () => {
        socket.destroy();
      });
    });
    const signals = await signalsUntilClosed(url);

    expect(kinds(signals)).toEqual(['open', 'frame_too_large', 'closed']);
    expect(signals[1]).toEqual({ kind: 'frame_too_large', observed_value: null });
  });

  it('no sigue redirecciones', async () => {
    let redirected = false;
    const target = await wsServer(() => {
      redirected = true;
    });
    const url = await rawServer((_request, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target}\r\nContent-Length: 0\r\n\r\n`);
    });
    const signals = await signalsUntilClosed(url);

    expect(kinds(signals)).toEqual(['error', 'closed']);
    expect(redirected).toBe(false);
  });
});
