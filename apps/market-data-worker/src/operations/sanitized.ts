/**
 * Un código, un evento o un motivo saneado de los informes de `buoh-operaciones` (ADR-0018 §11):
 * letras, cifras, `_`, `.` y `-`, de 1 a 64. Lo usan quien escribe los informes (`run.ts`) y quien
 * lee los de la salud (`stored-health.ts`), que no importa `run.ts`, para que la ruta
 * `@buoh/market-data-worker/lectura` no cargue el código de `buoh-operaciones`.
 */
export const SANITIZED = /^[A-Za-z0-9_.-]{1,64}$/u;
