/**
 * Tokens de marca de buoh (guía: docs/diseno/marca-buoh.md).
 * Son datos puros: no dependen de React ni del navegador, para que web, móvil y escritorio usen los mismos valores.
 */

export const palette = {
  noche: {
    950: '#060A12',
    900: '#0A101C',
    850: '#0E1626',
    800: '#131D31',
    750: '#1A2337',
    700: '#1A273F',
    600: '#25344F',
    500: '#5A6C8F',
  },
  niebla: {
    50: '#F4F6FB',
    200: '#C8D0E2',
    300: '#A7B2CB',
    400: '#8D9AB6',
  },
  luna: {
    100: '#F8F2E1',
    200: '#F0E5C6',
  },
  ambar: {
    400: '#F2B544',
    700: '#8A5A00',
  },
  papel: {
    0: '#FFFFFF',
    50: '#F5F6FA',
    100: '#EEF1F7',
    150: '#ECEFF5',
    200: '#E3E7F0',
    300: '#CBD2E0',
    500: '#7D8AA3',
    600: '#55627D',
    700: '#33415C',
  },
  aurora: { 100: '#E1F4EE', 400: '#3CC8A4', 700: '#0B7259', 950: '#0D2925' },
  cielo: { 100: '#E2EDF8', 400: '#64B5F6', 700: '#1D67AD', 950: '#0D2136' },
  naranja: { 100: '#FAEADC', 400: '#F0904F', 700: '#A44C14', 950: '#2E1C10' },
  rojo: { 100: '#FAE3E3', 400: '#F27474', 700: '#B83434', 950: '#2F1518' },
  violeta: { 100: '#ECE9FB', 400: '#A99AF7', 700: '#5A47C8', 950: '#1E1A3A' },
  cian: { 100: '#DEF2F5', 400: '#4CCAE0', 700: '#0A6F82', 950: '#0B2731' },
  rosa: { 100: '#F9E3ED', 400: '#F283B3', 700: '#AA3166', 950: '#2F1526' },
} as const;

/** Tonos semánticos para estados. Nunca se usan solos: siempre van con texto e icono. */
export const TONES = [
  'aurora',
  'cielo',
  'naranja',
  'rojo',
  'niebla',
  'violeta',
  'cian',
  'rosa',
] as const;
export type Tone = (typeof TONES)[number];

export interface ToneColors {
  /** Texto e icono del estado. */
  readonly fg: string;
  /** Fondo suave de la insignia. */
  readonly bg: string;
}

export interface Theme {
  readonly name: 'noche' | 'dia';
  readonly bg: {
    readonly canvas: string;
    readonly sunken: string;
    readonly surface: string;
    readonly raised: string;
    readonly hover: string;
  };
  readonly border: { readonly subtle: string; readonly default: string; readonly strong: string };
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    readonly muted: string;
    readonly inverse: string;
  };
  readonly brand: { readonly accent: string; readonly head: string; readonly eyeRing: string };
  readonly action: { readonly bg: string; readonly bgHover: string; readonly fg: string };
  readonly focus: string;
  readonly tones: Readonly<Record<Tone, ToneColors>>;
  readonly chart: { readonly line: string; readonly grid: string; readonly gap: string };
}

const p = palette;

export const nightTheme: Theme = {
  name: 'noche',
  bg: {
    canvas: p.noche[900],
    sunken: p.noche[950],
    surface: p.noche[850],
    raised: p.noche[800],
    hover: p.noche[700],
  },
  border: { subtle: p.noche[700], default: p.noche[600], strong: p.noche[500] },
  text: {
    primary: p.niebla[50],
    secondary: p.niebla[200],
    muted: p.niebla[400],
    inverse: p.noche[900],
  },
  brand: { accent: p.ambar[400], head: p.luna[200], eyeRing: p.noche[900] },
  action: { bg: p.luna[200], bgHover: p.luna[100], fg: p.noche[900] },
  focus: p.cielo[400],
  tones: {
    aurora: { fg: p.aurora[400], bg: p.aurora[950] },
    cielo: { fg: p.cielo[400], bg: p.cielo[950] },
    naranja: { fg: p.naranja[400], bg: p.naranja[950] },
    rojo: { fg: p.rojo[400], bg: p.rojo[950] },
    niebla: { fg: p.niebla[300], bg: p.noche[750] },
    violeta: { fg: p.violeta[400], bg: p.violeta[950] },
    cian: { fg: p.cian[400], bg: p.cian[950] },
    rosa: { fg: p.rosa[400], bg: p.rosa[950] },
  },
  chart: { line: p.luna[200], grid: p.noche[700], gap: p.naranja[400] },
};

export const dayTheme: Theme = {
  name: 'dia',
  bg: {
    canvas: p.papel[50],
    sunken: p.papel[150],
    surface: p.papel[0],
    raised: p.papel[0],
    hover: p.papel[100],
  },
  border: { subtle: p.papel[200], default: p.papel[300], strong: p.papel[500] },
  text: {
    primary: p.noche[850],
    secondary: p.papel[700],
    muted: p.papel[600],
    inverse: p.niebla[50],
  },
  brand: { accent: p.ambar[700], head: p.noche[850], eyeRing: p.papel[0] },
  action: { bg: p.noche[850], bgHover: p.noche[700], fg: p.niebla[50] },
  focus: p.cielo[700],
  tones: {
    aurora: { fg: p.aurora[700], bg: p.aurora[100] },
    cielo: { fg: p.cielo[700], bg: p.cielo[100] },
    naranja: { fg: p.naranja[700], bg: p.naranja[100] },
    rojo: { fg: p.rojo[700], bg: p.rojo[100] },
    niebla: { fg: p.papel[600], bg: p.papel[150] },
    violeta: { fg: p.violeta[700], bg: p.violeta[100] },
    cian: { fg: p.cian[700], bg: p.cian[100] },
    rosa: { fg: p.rosa[700], bg: p.rosa[100] },
  },
  chart: { line: p.noche[850], grid: p.papel[200], gap: p.naranja[700] },
};

export const themes = { noche: nightTheme, dia: dayTheme } as const;

export const typography = {
  family: {
    sans: "'Manrope Variable', 'Manrope', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  },
  /** Escala en rem sobre 16 px. */
  size: {
    xs: '0.75rem',
    sm: '0.8125rem',
    md: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
    '5xl': '3rem',
    '6xl': '3.75rem',
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.15, snug: 1.3, normal: 1.55 },
  letterSpacing: { brand: '-0.02em', caps: '0.06em' },
} as const;

export const space = {
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
} as const;

export const radius = { sm: '6px', md: '10px', lg: '14px', xl: '20px', pill: '999px' } as const;

export const motion = {
  duration: { fast: '120ms', base: '200ms', slow: '320ms' },
  easing: { standard: 'cubic-bezier(0.2, 0, 0, 1)' },
} as const;

export const breakpoints = { sm: 640, md: 960, lg: 1200, xl: 1440 } as const;

/** Área táctil mínima en píxeles (guía §10). */
export const MIN_TOUCH_TARGET_PX = 44;
