import { readdirSync, readFileSync } from 'node:fs';
import { executionModeSchema, serviceHealthSchema, severitySchema } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  EXECUTION_MODE_PRESENTATION,
  ICONS,
  LOGO_SYMBOL,
  LOGO_WORDMARK,
  palette,
  renderCss,
  SERVICE_HEALTH_PRESENTATION,
  SEVERITY_PRESENTATION,
  sharedVariables,
  space,
  themes,
  TONES,
  typography,
  WCAG_AA,
  type Theme,
} from '../src/index.js';

const THEMES: readonly Theme[] = [themes.noche, themes.dia];
const PALETTE_VALUES = new Set(
  Object.values(palette).flatMap((family) => Object.values(family).map((v) => v.toUpperCase())),
);

function backgroundsOf(theme: Theme): Readonly<Record<string, string>> {
  return { ...theme.bg };
}

describe('contraste WCAG 2.2 AA (V1-DS-001)', () => {
  for (const theme of THEMES) {
    it(`tema ${theme.name}: textos legibles sobre todos los fondos, incluido hover`, () => {
      for (const [bgName, bg] of Object.entries(backgroundsOf(theme))) {
        for (const [textName, fg] of Object.entries(theme.text)) {
          if (textName === 'inverse') {
            continue;
          }
          expect(contrastRatio(fg, bg), `${textName} sobre ${bgName}`).toBeGreaterThanOrEqual(
            WCAG_AA.text,
          );
        }
      }
    });

    it(`tema ${theme.name}: estados legibles sobre su insignia y sobre todos los fondos`, () => {
      for (const tone of TONES) {
        const { fg, bg } = theme.tones[tone];
        expect(contrastRatio(fg, bg), `${tone} sobre su fondo`).toBeGreaterThanOrEqual(
          WCAG_AA.text,
        );
        for (const [bgName, surface] of Object.entries(backgroundsOf(theme))) {
          expect(contrastRatio(fg, surface), `${tone} sobre ${bgName}`).toBeGreaterThanOrEqual(
            WCAG_AA.text,
          );
        }
      }
    });

    it(`tema ${theme.name}: acción principal, foco, bordes de controles y acento`, () => {
      expect(contrastRatio(theme.action.fg, theme.action.bg)).toBeGreaterThanOrEqual(WCAG_AA.text);
      expect(contrastRatio(theme.action.fg, theme.action.bgHover)).toBeGreaterThanOrEqual(
        WCAG_AA.text,
      );
      for (const [bgName, bg] of Object.entries(backgroundsOf(theme))) {
        expect(contrastRatio(theme.focus, bg), `foco sobre ${bgName}`).toBeGreaterThanOrEqual(
          WCAG_AA.ui,
        );
        expect(
          contrastRatio(theme.border.strong, bg),
          `borde fuerte sobre ${bgName}`,
        ).toBeGreaterThanOrEqual(WCAG_AA.ui);
        expect(
          contrastRatio(theme.brand.accent, bg),
          `acento sobre ${bgName}`,
        ).toBeGreaterThanOrEqual(WCAG_AA.text);
      }
    });

    it(`tema ${theme.name}: todos sus colores salen de la paleta`, () => {
      const json = JSON.stringify(theme);
      for (const hex of json.match(/#[0-9A-F]{6}/gi) ?? []) {
        expect(PALETTE_VALUES.has(hex.toUpperCase()), hex).toBe(true);
      }
    });
  }

  it('calcula los extremos conocidos', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('estados del contrato con texto, icono y tono (V1-DS-001)', () => {
  const cases = [
    ['execution_mode', executionModeSchema.options, EXECUTION_MODE_PRESENTATION],
    ['service_health', serviceHealthSchema.options, SERVICE_HEALTH_PRESENTATION],
    ['severity', severitySchema.options, SEVERITY_PRESENTATION],
  ] as const;

  for (const [axis, values, presentation] of cases) {
    it(`${axis}: cada valor tiene presentación`, () => {
      const map = presentation as Readonly<
        Record<string, { label: string; description: string; icon: string; tone: string }>
      >;
      expect(Object.keys(map).sort()).toEqual([...values].sort());
      for (const value of values) {
        const item = map[value];
        expect(item?.label.length, value).toBeGreaterThan(0);
        expect(item?.description.length, value).toBeGreaterThan(0);
        expect(Object.keys(ICONS)).toContain(item?.icon);
        expect(TONES).toContain(item?.tone);
      }
    });
  }

  it('modo y salud no comparten tonos, salvo el neutro de pausa y desactivado', () => {
    const modeTones = new Set(Object.values(EXECUTION_MODE_PRESENTATION).map((p) => p.tone));
    const healthTones = new Set(Object.values(SERVICE_HEALTH_PRESENTATION).map((p) => p.tone));
    const shared = [...modeTones].filter((tone) => healthTones.has(tone));
    expect(shared).toEqual(['niebla']);
  });

  it('modo y salud no comparten iconos', () => {
    const modeIcons = new Set(Object.values(EXECUTION_MODE_PRESENTATION).map((p) => p.icon));
    for (const health of Object.values(SERVICE_HEALTH_PRESENTATION)) {
      expect(modeIcons.has(health.icon), health.label).toBe(false);
    }
  });

  it('el verde azulado de marca no se usa en ningún estado', () => {
    for (const theme of THEMES) {
      const toneColors = TONES.flatMap((tone) => [theme.tones[tone].fg, theme.tones[tone].bg]);
      for (const brand of [
        ...Object.values(palette.boreal),
        theme.brand.accent,
        theme.brand.mark,
      ]) {
        expect(toneColors).not.toContain(brand);
      }
    }
  });

  it('el estado «saludable» se distingue del verde azulado de marca por el tono', () => {
    // Guía §5: el verde de «saludable» se separa al menos 25° de tono del verde azulado del logo.
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const healthy = SERVICE_HEALTH_PRESENTATION.healthy.tone;
    for (const theme of THEMES) {
      const gap = Math.abs(hue(theme.tones[healthy].fg) - hue(theme.brand.mark));
      expect(Math.min(gap, 360 - gap), theme.name).toBeGreaterThanOrEqual(25);
    }
  });
});

/** Extrae las variables declaradas en el bloque de un selector exacto. */
function variablesIn(css: string, selector: string): Readonly<Record<string, string>> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--b-[\w-]+): ([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

describe('CSS generado desde los tokens (V1-DS-001)', () => {
  const css = renderCss();
  const night = variablesIn(css, ":root, [data-theme='noche']");
  const day = variablesIn(css, "[data-theme='dia']");
  const shared = variablesIn(css, ':root');

  it('cada tema declara sus valores literales de la guía en su propio bloque', () => {
    expect(night).toMatchObject({
      '--b-bg-canvas': '#080F1B',
      '--b-bg-surface': '#0E1626',
      '--b-text': '#F4F6FB',
      '--b-text-2': '#C8D0E2',
      '--b-text-muted': '#8D9AB6',
      '--b-action-bg': '#EDECE0',
      '--b-brand-mark': '#24A598',
      '--b-brand-mark-detail': '#EDECE0',
      '--b-tone-rosa-fg': '#F283B3',
      '--b-tone-niebla-bg': '#1A2337',
    });
    expect(day).toMatchObject({
      '--b-bg-canvas': '#F5F6FA',
      '--b-bg-surface': '#FFFFFF',
      '--b-text': '#0E1626',
      '--b-text-2': '#33415C',
      '--b-text-muted': '#55627D',
      '--b-action-bg': '#0E1626',
      '--b-brand-mark': '#11756B',
      '--b-brand-mark-detail': '#0E1626',
      '--b-tone-rosa-fg': '#AA3166',
      '--b-tone-niebla-bg': '#ECEFF5',
    });
    expect(Object.keys(day).sort()).toEqual(Object.keys(night).sort());
  });

  it('las variables comunes cubren tipografía, espacios, radios y movimiento', () => {
    expect(shared).toEqual(sharedVariables());
    for (const size of Object.keys(typography.size)) {
      expect(shared).toHaveProperty(`--b-size-${size}`);
    }
    expect(Object.keys(shared).filter((k) => k.startsWith('--b-space-'))).toHaveLength(
      Object.keys(space).length,
    );
    expect(shared['--b-space-0_5']).toBe('0.125rem');
    expect(shared['--b-font-mono']).toContain('JetBrains Mono');
    expect(shared['--b-font-sans']).toMatch(/^'Sen Variable', 'Sen',/);
  });

  it('ningún texto usa opacidad: solo los controles desactivados', () => {
    const rules = [...css.matchAll(/([^{}]+)\{[^}]*opacity:[^}]*\}/g)].map((m) => m[1]?.trim());
    expect(rules).toEqual([".b-button:disabled, .b-button[aria-disabled='true']"]);
  });

  it('es estable y desactiva el movimiento cuando el sistema lo pide', () => {
    expect(renderCss()).toBe(css);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('guía de marca y recursos frente a los tokens (V1-BRAND-001)', () => {
  const guide = readFileSync(
    new URL('../../../docs/diseno/marca-buoh.md', import.meta.url),
    'utf8',
  );
  const guideHex = new Set((guide.match(/#[0-9A-F]{6}/gi) ?? []).map((h) => h.toUpperCase()));

  it('la guía documenta cada color de la paleta', () => {
    for (const hex of PALETTE_VALUES) {
      expect(guideHex.has(hex), hex).toBe(true);
    }
  });

  it('la guía no menciona colores fuera de la paleta', () => {
    for (const hex of guideHex) {
      expect(PALETTE_VALUES.has(hex), hex).toBe(true);
    }
  });

  it('cada archivo del logotipo usa los mismos trazados que src/logo.ts', () => {
    const dir = new URL('../assets/', import.meta.url);
    const read = (file: string) => readFileSync(new URL(file, dir), 'utf8');
    const symbolColor = [
      'buoh-simbolo.svg',
      'buoh-simbolo-dia.svg',
      'buoh-logo.svg',
      'buoh-logo-dia.svg',
      'buoh-icono.svg',
    ];
    for (const file of symbolColor) {
      expect(read(file), file).toContain(`d="${LOGO_SYMBOL.primary}"`);
      expect(read(file), file).toContain(`d="${LOGO_SYMBOL.detail}"`);
    }
    for (const file of ['buoh-simbolo-mono.svg', 'buoh-logo-mono.svg']) {
      expect(read(file), file).toContain(`d="${LOGO_SYMBOL.mono}"`);
    }
    for (const file of [
      'buoh-logo.svg',
      'buoh-logo-dia.svg',
      'buoh-logo-mono.svg',
      'buoh-palabra.svg',
    ]) {
      expect(read(file), file).toContain(`d="${LOGO_WORDMARK.d}"`);
    }
    // Colores del original: verde azulado y crema sobre noche
    expect(read('buoh-logo.svg')).toContain(`fill="${palette.boreal[400]}"`);
    expect(read('buoh-logo.svg')).toContain(`fill="${palette.luna[200]}"`);
    expect(read('buoh-icono.svg')).toContain(`fill="${palette.noche[900]}"`);
    expect(read('buoh-logo.svg')).not.toMatch(/<text\b|font-family/);
  });

  it('los SVG del logotipo usan solo colores de la paleta', () => {
    const dir = new URL('../assets/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const svg = readFileSync(new URL(file, dir), 'utf8');
      for (const hex of svg.match(/#[0-9A-F]{6}/gi) ?? []) {
        expect(PALETTE_VALUES.has(hex.toUpperCase()), `${file} ${hex}`).toBe(true);
      }
    }
  });
});
