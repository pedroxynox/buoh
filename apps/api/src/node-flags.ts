/**
 * Los tamaños de V8 con que arranca la API en producción (ADR-0019 §10 y §12). Node dimensiona V8
 * con la memoria que ve; sin un límite visible elegiría un heap enorme. Con estos tamaños se comporta
 * como en el servicio Starter de 512 MB de Render, sin depender de que la plataforma le muestre su
 * límite, igual que el worker (ADR-0018 §3). El PR 6a los fijó con una medición
 * (`docs/operacion/evidencia-memoria-f2-3.md`). Van delante del script, en el `startCommand` del
 * Blueprint y en el script `start` del paquete; dentro del proceso no se leen.
 */
export const API_NODE_FLAGS = ['--max-semi-space-size=1', '--max-old-space-size=256'] as const;
