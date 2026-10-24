import { executionModeSchema, serviceHealthSchema, severitySchema } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  EXECUTION_MODE_PRESENTATION,
  ICONS,
  renderCss,
  SERVICE_HEALTH_PRESENTATION,
  SEVERITY_PRESENTATION,
  themes,
  themeVariables,
  TONES,
  WCAG_AA,
  type Theme,
} from '../src/index.js';

const THEMES: readonly Theme[] = [themes.noche, themes.dia];

describe('contraste WCAG 2.2 AA (V1-DS-001)', () => {
  for (const theme of THEMES) {
    const backgrounds = {
      canvas: theme.bg.canvas,
      surface: theme.bg.surface,
      raised: theme.bg.raised,
      sunken: theme.bg.sunken,
    };

    it(`tema ${theme.name}: textos legibles sobre todos los fondos`, () => {
      for (const [bgName, bg] of Object.entries(backgrounds)) {
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

    it(`tema ${theme.name}: estados legibles sobre su insignia y sobre superficies`, () => {
      for (const tone of TONES) {
        const { fg, bg } = theme.tones[tone];
        expect(contrastRatio(fg, bg), `${tone} sobre su fondo`).toBeGreaterThanOrEqual(
          WCAG_AA.text,
        );
        expect(contrastRatio(fg, theme.bg.surface), `${tone} sobre surface`).toBeGreaterThanOrEqual(
          WCAG_AA.text,
        );
      }
    });

    it(`tema ${theme.name}: acción principal, foco y bordes de controles`, () => {
      expect(contrastRatio(theme.action.fg, theme.action.bg)).toBeGreaterThanOrEqual(WCAG_AA.text);
      expect(contrastRatio(theme.action.fg, theme.action.bgHover)).toBeGreaterThanOrEqual(
        WCAG_AA.text,
      );
      for (const bg of [theme.bg.canvas, theme.bg.surface, theme.bg.raised]) {
        expect(contrastRatio(theme.focus, bg)).toBeGreaterThanOrEqual(WCAG_AA.ui);
        expect(contrastRatio(theme.border.strong, bg)).toBeGreaterThanOrEqual(WCAG_AA.ui);
      }
      expect(contrastRatio(theme.brand.accent, theme.bg.canvas)).toBeGreaterThanOrEqual(
        WCAG_AA.text,
      );
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

  it('el ámbar de marca no es un tono de estado', () => {
    for (const theme of THEMES) {
      const toneColors = TONES.flatMap((tone) => [theme.tones[tone].fg, theme.tones[tone].bg]);
      expect(toneColors).not.toContain(theme.brand.accent);
    }
  });
});

describe('CSS generado desde los tokens (V1-DS-001)', () => {
  const css = renderCss();

  it('declara cada variable de ambos temas con su valor', () => {
    for (const theme of THEMES) {
      for (const [name, value] of Object.entries(themeVariables(theme))) {
        expect(css).toContain(`${name}: ${value};`);
      }
    }
    expect(css).toContain("[data-theme='dia'] {");
  });

  it('es estable: dos generaciones son idénticas', () => {
    expect(renderCss()).toBe(css);
  });

  it('desactiva el movimiento cuando el sistema lo pide', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
