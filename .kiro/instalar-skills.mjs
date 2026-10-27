// Instala las skills de terceros que usa el agente de Kiro (ADR-0014). Descarga cada origen en el
// commit fijado abajo, fuera del repositorio, y copia las skills elegidas, cada una con la licencia
// de su proyecto, a la carpeta donde Kiro Web las encuentra. Nada de esto entra en Git.
//
// Uso: `node .kiro/instalar-skills.mjs`. Salidas: 0 todo instalado; 1 algún origen no se instaló
// (los demás sí); 2 una de las carpetas de trabajo está dentro del repositorio.
//
// Actualizar un origen es un PR propio que cambia su commit. El diff del origen entre ambos commits
// se revisa como el de una dependencia, y `.kiro/steering/skills-de-kiro.md` tiene que seguir
// valiendo.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGENES = [
  {
    nombre: 'caveman',
    url: 'https://github.com/JuliusBrussee/caveman.git',
    commit: '9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4',
    carpeta: 'skills',
    // Solo la voz del chat (ADR-0014 §1).
    skills: ['caveman'],
    // Apache-2.0, su NOTICE y la licencia MIT que cubría la skill antes de su versión 3.0.0.
    licencias: ['LICENSE', 'NOTICE', 'LICENSE-MIT'],
  },
  {
    nombre: 'superpowers',
    url: 'https://github.com/obra/superpowers.git',
    commit: '2ce8aa15d05bd57213e6f746f953aafb7ded7a8b',
    carpeta: 'skills',
    skills: [
      'brainstorming',
      'diagnosing-superpowers',
      'dispatching-parallel-agents',
      'executing-plans',
      'finishing-a-development-branch',
      'receiving-code-review',
      'requesting-code-review',
      'subagent-driven-development',
      'systematic-debugging',
      'test-driven-development',
      'using-git-worktrees',
      'using-superpowers',
      'verification-before-completion',
      'writing-plans',
      'writing-skills',
    ],
    licencias: ['LICENSE'],
  },
  {
    nombre: 'day-trader-skill',
    url: 'https://github.com/Jakeschincariol/day-trader-skill.git',
    commit: '3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd',
    carpeta: '.',
    // Todas menos trader-broker (PROHIBIDAS).
    skills: [
      'trader-alerts',
      'trader-analyst',
      'trader-budget',
      'trader-entry',
      'trader-exit',
      'trader-news',
      'trader-pelosi',
      'trader-risk',
      'trader-scanner',
      'trader-timemachine',
    ],
    licencias: ['LICENSE'],
  },
];

// Envía órdenes a un bróker (ADR-0014 §5). No se instala, y se borra si una sesión la dejó.
const PROHIBIDAS = ['trader-broker'];

const repositorio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destino = resolve(process.env['KIRO_SKILLS_DIR'] ?? '/projects/sandbox/.kiro/skills');
const descargas = resolve(
  process.env['BUOH_SKILLS_SRC_DIR'] ?? '/projects/sandbox/.buoh-local/skills-src',
);

function estaDentro(base, ruta) {
  const camino = relative(base, ruta);
  return camino !== '..' && !camino.startsWith(`..${sep}`) && !isAbsolute(camino);
}

function git(...argumentos) {
  return execFileSync('git', argumentos, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/** Descarga solo el commit fijado. Git comprueba que el contenido corresponde a su hash. */
function descargar({ nombre, url, commit }) {
  const copia = join(descargas, nombre);
  rmSync(copia, { recursive: true, force: true });
  git('init', '-q', copia);
  git('-C', copia, 'fetch', '-q', '--depth', '1', url, commit);
  git('-C', copia, 'checkout', '-q', 'FETCH_HEAD');
  const descargado = git('-C', copia, 'rev-parse', 'HEAD');
  if (descargado !== commit) {
    throw new Error(`se descargó ${descargado} en lugar de ${commit}`);
  }
  return copia;
}

function instalar(origen) {
  const copia = descargar(origen);
  const faltan = origen.skills.filter(
    (skill) => !existsSync(join(copia, origen.carpeta, skill, 'SKILL.md')),
  );
  if (faltan.length > 0) {
    throw new Error(`el commit no tiene ${faltan.join(', ')}`);
  }

  for (const skill of origen.skills) {
    const carpeta = join(destino, skill);
    // Se sustituye entera, para no dejar archivos de otra versión.
    rmSync(carpeta, { recursive: true, force: true });
    cpSync(join(copia, origen.carpeta, skill), carpeta, { recursive: true });
    for (const licencia of origen.licencias) {
      cpSync(join(copia, licencia), join(carpeta, licencia));
    }
  }
}

function main() {
  for (const carpeta of [destino, descargas]) {
    if (estaDentro(repositorio, carpeta)) {
      console.error(
        `${carpeta} está dentro del repositorio: las skills de terceros no entran en Git.`,
      );
      return 2;
    }
  }

  mkdirSync(destino, { recursive: true });
  for (const skill of PROHIBIDAS) {
    rmSync(join(destino, skill), { recursive: true, force: true });
  }

  let instaladas = 0;
  let salida = 0;
  for (const origen of ORIGENES) {
    try {
      instalar(origen);
      instaladas += origen.skills.length;
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.error(`No se instaló ${origen.nombre}: ${motivo}`);
      salida = 1;
    }
  }

  console.log(`Skills instaladas en ${destino}: ${String(instaladas)}`);
  return salida;
}

process.exitCode = main();
