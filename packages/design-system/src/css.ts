import { TONES, motion, palette, radius, space, themes, typography, type Theme } from './tokens.js';

/** Nombre de la variable CSS de un token de espacio (`1.5` → `--b-space-1_5`). */
export function spaceVar(key: keyof typeof space): string {
  return `--b-space-${String(key).replace('.', '_')}`;
}

/** Variables CSS que dependen del tema. */
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {
    '--b-bg-canvas': theme.bg.canvas,
    '--b-bg-sunken': theme.bg.sunken,
    '--b-bg-surface': theme.bg.surface,
    '--b-bg-raised': theme.bg.raised,
    '--b-bg-hover': theme.bg.hover,
    '--b-border-subtle': theme.border.subtle,
    '--b-border': theme.border.default,
    '--b-border-strong': theme.border.strong,
    '--b-text': theme.text.primary,
    '--b-text-2': theme.text.secondary,
    '--b-text-muted': theme.text.muted,
    '--b-text-inverse': theme.text.inverse,
    '--b-brand-accent': theme.brand.accent,
    '--b-brand-head': theme.brand.head,
    '--b-brand-eye-ring': theme.brand.eyeRing,
    '--b-brand-iris': palette.ambar[400],
    '--b-action-bg': theme.action.bg,
    '--b-action-bg-hover': theme.action.bgHover,
    '--b-action-fg': theme.action.fg,
    '--b-focus': theme.focus,
    '--b-chart-line': theme.chart.line,
    '--b-chart-grid': theme.chart.grid,
    '--b-chart-gap': theme.chart.gap,
  };
  for (const tone of TONES) {
    vars[`--b-tone-${tone}-fg`] = theme.tones[tone].fg;
    vars[`--b-tone-${tone}-bg`] = theme.tones[tone].bg;
  }
  return vars;
}

/** Variables CSS comunes a los dos temas. */
export function sharedVariables(): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {
    '--b-font-sans': typography.family.sans,
    '--b-font-mono': typography.family.mono,
    '--b-duration-fast': motion.duration.fast,
    '--b-duration': motion.duration.base,
    '--b-duration-slow': motion.duration.slow,
    '--b-ease': motion.easing.standard,
  };
  for (const [key, value] of Object.entries(typography.size)) {
    vars[`--b-size-${key}`] = value;
  }
  for (const [key, value] of Object.entries(space)) {
    vars[spaceVar(Number(key) as keyof typeof space)] = value;
  }
  for (const [key, value] of Object.entries(radius)) {
    vars[`--b-radius-${key}`] = value;
  }
  return vars;
}

function block(selector: string, vars: Readonly<Record<string, string>>): string {
  const lines = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

const toneRules = TONES.map(
  (tone) =>
    `[data-tone='${tone}'] {\n  --b-tone-fg: var(--b-tone-${tone}-fg);\n  --b-tone-bg: var(--b-tone-${tone}-bg);\n}`,
).join('\n');

const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--b-bg-canvas);
  color: var(--b-text);
  font-family: var(--b-font-sans);
  font-size: var(--b-size-base);
  line-height: ${String(typography.lineHeight.normal)};
  -webkit-font-smoothing: antialiased;
  font-feature-settings: 'ss01' on;
}
h1, h2, h3, h4 { margin: 0; line-height: ${String(typography.lineHeight.tight)}; letter-spacing: ${typography.letterSpacing.brand}; font-weight: ${String(typography.weight.bold)}; }
p { margin: 0; }
a { color: inherit; }
::selection { background: var(--b-brand-iris); color: ${palette.noche[900]}; }
:focus-visible { outline: 2px solid var(--b-focus); outline-offset: 2px; border-radius: var(--b-radius-sm); }
[data-theme] { background: var(--b-bg-canvas); color: var(--b-text); }

.b-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.b-num { font-family: var(--b-font-mono); font-variant-numeric: tabular-nums; letter-spacing: 0; }
.b-eyebrow {
  font-size: var(--b-size-xs); font-weight: ${String(typography.weight.semibold)};
  letter-spacing: ${typography.letterSpacing.caps}; text-transform: uppercase; color: var(--b-text-muted);
}
.b-muted { color: var(--b-text-muted); }
.b-secondary { color: var(--b-text-2); }

.b-icon {
  width: 1.25em; height: 1.25em; flex-shrink: 0;
  fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round;
}

.b-badge {
  display: inline-flex; align-items: center; gap: 0.375rem;
  padding: 0.3rem 0.65rem; border-radius: var(--b-radius-pill);
  border: 1px solid color-mix(in srgb, var(--b-tone-fg, var(--b-text-2)) 40%, transparent);
  background: var(--b-tone-bg, var(--b-bg-raised)); color: var(--b-tone-fg, var(--b-text-2));
  font-size: var(--b-size-xs); font-weight: ${String(typography.weight.semibold)}; line-height: 1; white-space: nowrap;
}
.b-badge .b-icon { width: 14px; height: 14px; }
.b-badge__detail { font-weight: ${String(typography.weight.medium)}; opacity: 0.85; }
.b-badge--strong { border-width: 1.5px; border-color: var(--b-tone-fg, var(--b-text-2)); }

.b-button {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--b-space-2);
  min-height: 2.5rem; padding: 0 var(--b-space-4); border-radius: var(--b-radius-md);
  border: 1px solid transparent; font: inherit; font-size: var(--b-size-md); font-weight: ${String(typography.weight.semibold)};
  cursor: pointer; text-decoration: none;
  transition: background-color var(--b-duration-fast) var(--b-ease), border-color var(--b-duration-fast) var(--b-ease);
}
.b-button--primary { background: var(--b-action-bg); color: var(--b-action-fg); }
.b-button--primary:hover:not(:disabled) { background: var(--b-action-bg-hover); }
.b-button--secondary { background: transparent; color: var(--b-text); border-color: var(--b-border-strong); }
.b-button--secondary:hover:not(:disabled) { background: var(--b-bg-hover); }
.b-button--quiet { background: transparent; color: var(--b-text-2); }
.b-button--quiet:hover:not(:disabled) { background: var(--b-bg-hover); color: var(--b-text); }
.b-button:disabled, .b-button[aria-disabled='true'] { opacity: 0.5; cursor: not-allowed; }
@media (pointer: coarse) { .b-button { min-height: 44px; } }

.b-card {
  background: var(--b-bg-surface); border: 1px solid var(--b-border-subtle);
  border-radius: var(--b-radius-lg); padding: var(--b-space-5);
}
.b-card--raised { background: var(--b-bg-raised); }
.b-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--b-space-3); margin-bottom: var(--b-space-4); }
.b-card__title { font-size: var(--b-size-lg); font-weight: ${String(typography.weight.bold)}; letter-spacing: ${typography.letterSpacing.brand}; }
.b-card__subtitle { margin-top: var(--b-space-1); color: var(--b-text-muted); font-size: var(--b-size-sm); }

.b-notice {
  display: inline-flex; align-items: center; gap: var(--b-space-2);
  padding: 0.3rem 0.7rem; border-radius: var(--b-radius-sm);
  border: 1px dashed var(--b-tone-fg, var(--b-border-strong)); color: var(--b-tone-fg, var(--b-text-2));
  font-size: var(--b-size-xs); font-weight: ${String(typography.weight.semibold)};
}

.b-phase-lock {
  display: grid; gap: var(--b-space-2); padding: var(--b-space-4);
  border: 1px dashed var(--b-border-strong); border-radius: var(--b-radius-md);
  background: var(--b-bg-sunken); color: var(--b-text-2); font-size: var(--b-size-sm);
}
.b-phase-lock__title { display: flex; align-items: center; gap: var(--b-space-2); color: var(--b-text); font-weight: ${String(typography.weight.semibold)}; }

.b-metric { display: grid; gap: var(--b-space-3); }
.b-metric__label { color: var(--b-text-2); font-size: var(--b-size-sm); font-weight: ${String(typography.weight.semibold)}; }
.b-metric__value { font-family: var(--b-font-mono); font-variant-numeric: tabular-nums; font-size: var(--b-size-3xl); font-weight: ${String(typography.weight.semibold)}; letter-spacing: -0.01em; }
.b-metric__context {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: var(--b-space-2) var(--b-space-4);
  margin: 0; padding-top: var(--b-space-3); border-top: 1px solid var(--b-border-subtle); font-size: var(--b-size-sm);
}
.b-metric__context dt { color: var(--b-text-muted); font-size: var(--b-size-xs); }
.b-metric__context dd { margin: 0; color: var(--b-text); }
.b-metric__limits { color: var(--b-text-2); font-size: var(--b-size-sm); }

.b-table { width: 100%; border-collapse: collapse; font-size: var(--b-size-md); }
.b-table th {
  text-align: left; padding: var(--b-space-2) var(--b-space-3); color: var(--b-text-muted);
  font-size: var(--b-size-xs); font-weight: ${String(typography.weight.semibold)}; letter-spacing: ${typography.letterSpacing.caps}; text-transform: uppercase;
}
.b-table td { padding: var(--b-space-3); border-top: 1px solid var(--b-border-subtle); vertical-align: middle; }
.b-table tbody tr:hover { background: var(--b-bg-hover); }

.b-divider { border: 0; border-top: 1px solid var(--b-border-subtle); margin: var(--b-space-4) 0; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}
`;

/** Hoja de estilos completa de la marca: variables de ambos temas, base y componentes. */
export function renderCss(): string {
  return [
    '/* buoh design system. Generado desde src/tokens.ts; no editar a mano. */',
    block(':root', sharedVariables()),
    block(":root, [data-theme='noche']", themeVariables(themes.noche)),
    block("[data-theme='dia']", themeVariables(themes.dia)),
    toneRules,
    BASE_CSS.trim(),
    '',
  ].join('\n\n');
}
