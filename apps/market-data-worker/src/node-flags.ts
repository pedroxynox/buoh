/**
 * Los tamaños de V8 de los procesos del worker que leen el log durable: `ingest` (el script `ingest`
 * de este paquete) y `data:health` (`scripts/data-health.mjs`), ADR-0017 §9. Son los que Node elige
 * cuando ve un límite de memoria de 512 MiB, como el del worker Starter de Render: semiespacios de
 * 1 MiB y 256 MiB para la generación vieja. Fijarlos hace que la memoria no dependa de que la
 * plataforma deje ver su límite. Si no lo deja ver, Node dimensiona V8 con la memoria de la máquina:
 * en un sandbox de 31 GiB, la generación joven llegó a 128 MiB y la reconstrucción por partes de un
 * log sin punto de control válido pasó de los techos de §9 (evidencia de memoria de F2.1).
 *
 * Solo cuentan si el proceso arranca con ellos: con el script `ingest` del paquete, con
 * `pnpm run data:health` o con estas opciones delante del script.
 */
export const WORKER_NODE_FLAGS = ['--max-semi-space-size=1', '--max-old-space-size=256'] as const;
