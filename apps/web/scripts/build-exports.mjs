// Dos exportaciones del mismo código (ADR-0019 §9), que elige la variable de compilación
// `NEXT_PUBLIC_BUOH_WEB_TARGET`, inlineada por Next para que el empaquetador elimine lo que sobra:
//   - `out`:     el prototipo del escritorio (ADR-0010), con datos ficticios, sin formularios y sin
//                llamar a la API. No incluye las pantallas de acceso ni de enlace.
//   - `out-api`: la que sirve la API (PR 6), con las pantallas de inicio de sesión, de enlace de
//                alta y el menú de la sesión.
// Se compila primero la variante de la API y se aparta en `out-api`, y luego la del escritorio, que
// queda en `out`. Cada compilación parte de un `.next` limpio: así la variable de compilación nunca
// llega inlineada de la compilación anterior.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

/** Rutas que solo existen en la variante de la API; se quitan de `out` (ADR-0019 §9). */
const API_ONLY_ROUTES = ['acceso', 'enlace'];

function remove(path) {
  rmSync(new URL(`../${path}`, import.meta.url), { recursive: true, force: true });
}

function build(target) {
  remove('.next');
  remove('out');
  execFileSync(process.execPath, [nextBin, 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_BUOH_WEB_TARGET: target },
  });
}

// La variante de la API, apartada en `out-api`.
remove('out-api');
build('api');
renameSync(new URL('../out', import.meta.url), new URL('../out-api', import.meta.url));

// La variante del escritorio, que queda en `out` y no lleva las pantallas de la API.
build('desktop');
for (const route of API_ONLY_ROUTES) {
  remove(`out/${route}`);
}
