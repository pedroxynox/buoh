// Escribe dist/buoh.css a partir de los tokens compilados. Se ejecuta después de tsc en `build`.
import { writeFileSync } from 'node:fs';
import { renderCss } from '../dist/index.js';

writeFileSync(new URL('../dist/buoh.css', import.meta.url), renderCss(), 'utf8');
