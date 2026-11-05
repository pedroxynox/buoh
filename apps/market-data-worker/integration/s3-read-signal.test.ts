import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createS3Client, S3ObjectStore } from '../src/index.js';

// El plazo de cada lectura de `S3ObjectStore` (`readSignal`, ADR-0019 §8) con el SDK y su manejador
// HTTP reales, contra un servidor local en el mismo proceso que responde como S3 y deja un cuerpo a
// medias. Solo usa la interfaz de loopback, y las credenciales son sintéticas.
const STALLED = `sha256/${'a'.repeat(64)}`;
const WHOLE = `sha256/${'b'.repeat(64)}`;
const BYTES = new Uint8Array(1000).fill(7);
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** Responde `HEAD` con el tamaño y `GET` con el cuerpo entero, salvo el de `STALLED`: 10 bytes y nada más. */
async function stallingServer(): Promise<string> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Length': String(BYTES.byteLength),
      'Content-Type': 'application/octet-stream',
      ETag: '"sintetico"',
      'Last-Modified': new Date(0).toUTCString(),
    });
    if (request.method === 'HEAD') {
      response.end();
    } else if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname.endsWith(STALLED)) {
      response.write(BYTES.subarray(0, 10));
    } else {
      response.end(BYTES);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('S3ObjectStore con plazo por lectura, contra un servidor HTTP local', () => {
  it('un cuerpo que deja de llegar se corta al vencer el plazo, y la lectura siguiente funciona', async () => {
    const endpoint = await stallingServer();
    const client = createS3Client(
      {
        accessKeyId: 'AKIDSINTETICO',
        bucket: 'buoh-prueba',
        endpoint,
        region: 'auto',
        secretAccessKey: 'clave-sintetica-de-prueba',
      },
      { connectionTimeout: 5000, requestTimeout: 10_000 },
    );
    closers.push(() => {
      client.destroy();
      return Promise.resolve();
    });
    const store = new S3ObjectStore(client, 'buoh-prueba', '', {
      readSignal: () => AbortSignal.timeout(300),
    });
    const started = performance.now();
    await expect(store.get(STALLED, 5000)).rejects.toMatchObject({ name: 'TimeoutError' });
    // El plazo del cliente, 10 s, no cubre el cuerpo: lo corta el de la lectura.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await store.get(WHOLE, 5000)).toEqual(BYTES);
    // Sin el plazo por lectura, el mismo cuerpo sigue esperando.
    const waiting = new S3ObjectStore(client, 'buoh-prueba').get(STALLED, 5000);
    const outcome = await Promise.race([
      waiting.then(
        () => 'resuelto',
        () => 'rechazado',
      ),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('sigue esperando');
        }, 1000);
      }),
    ]);
    expect(outcome).toBe('sigue esperando');
  });
});
