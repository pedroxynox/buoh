// Evidencia de memoria de F2.1 (ADR-0017 §9). No es un comando del producto: `medir-memoria.mjs` lo
// carga con `--import` en el proceso de `data:health`, que corre sin cambios.
//
// Al salir, escribe en stderr una línea JSON con el máximo de memoria residente del proceso, en KiB
// (`getrusage`, `ru_maxrss`), como midió ADR-0016 («Medición») el de `data:health`.
import { writeSync } from 'node:fs';

process.on('exit', () => {
  writeSync(
    2,
    `${JSON.stringify({ event: 'evidencia_max_rss_kib', value: process.resourceUsage().maxRSS })}\n`,
  );
});
