/**
 * Los límites de V8 de los procesos del worker que leen el log durable: `ingest` (el script `ingest`
 * de este paquete) y `data:health` (`scripts/data-health.mjs`), ADR-0017 §9. Sin ellos, V8 deja
 * crecer la generación joven hasta 128 MiB, también con un límite de memoria de 512 MiB, y el límite
 * de la generación vieja sale de la memoria de la máquina, así que la reconstrucción por partes de un
 * log sin punto de control válido pasaba de los techos de §9 (evidencia de memoria de F2.1):
 *
 * - `--max-semi-space-size=16`: cada semiespacio de la generación joven, como mucho 16 MiB;
 * - `--max-old-space-size=192`: la generación vieja, como mucho 192 MiB, muy por encima de lo que el
 *   worker guarda vivo, con la cola de frames de 32 MiB como mucho (ADR-0004 §7).
 */
export const WORKER_NODE_FLAGS = ['--max-semi-space-size=16', '--max-old-space-size=192'] as const;
