/** Contraste WCAG 2.2 entre dos colores `#RRGGBB`. */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) {
    throw new Error(`Color no válido: ${hex}`);
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    channel(Number.parseInt(part ?? '', 16)),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mínimos de WCAG 2.2 AA. */
export const WCAG_AA = { text: 4.5, large: 3, ui: 3 } as const;
