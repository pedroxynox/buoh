import { palette } from '@buoh/design-system';
import { encode } from 'uqr';

/**
 * Dibuja un código QR como SVG en línea (ADR-0019 §1 y §3): se genera dentro de buoh, nunca en un
 * servicio de terceros, con `uqr` (MIT, sin dependencias). Al ser un SVG en línea cumple la política
 * de contenido de la API sin `img-src` ni `data:` (ADR-0019 §9).
 *
 * Los colores son fijos y de máximo contraste, no los del tema: un QR con poco contraste no se lee.
 * Se toman de la paleta de la marca (crema sobre noche), con el margen de silencio que pide la norma
 * (`border: 4`), que `uqr` incluye ya en la matriz.
 */
export function Qr({ value, label }: { readonly value: string; readonly label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 4 });
  let path = '';
  for (let y = 0; y < size; y += 1) {
    const row = data[y];
    if (row === undefined) continue;
    for (let x = 0; x < size; x += 1) {
      if (row[x] === true) {
        path += `M${String(x)} ${String(y)}h1v1h-1z`;
      }
    }
  }
  return (
    <svg
      className="w-qr"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width="220"
      height="220"
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill={palette.luna[100]} />
      <path d={path} fill={palette.noche[950]} />
    </svg>
  );
}
