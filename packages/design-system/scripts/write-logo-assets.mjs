// Escribe assets/*.svg a partir de los trazados compilados (src/logo.ts y src/logo-svg.ts) y borra los
// SVG que ya no existen. Uso: pnpm --filter @buoh/design-system run logo:write
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { LOGO_FILES } from '../dist/index.js';

const dir = new URL('../assets/', import.meta.url);
for (const file of readdirSync(dir)) {
  if (file.endsWith('.svg') && !(file in LOGO_FILES)) {
    rmSync(new URL(file, dir));
  }
}
for (const [file, content] of Object.entries(LOGO_FILES)) {
  writeFileSync(new URL(file, dir), content, 'utf8');
}
console.log(`logo: ${String(Object.keys(LOGO_FILES).length)} archivos en assets/`);
