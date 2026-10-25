/**
 * Mayor caída desde un máximo previo, en las mismas unidades que la serie: para una curva en puntos
 * porcentuales es una resta de puntos, no un porcentaje del máximo. `at` es el índice del valle y
 * `peak` el valor del máximo (su índice no se devuelve). Una serie vacía o que solo sube da 0.
 *
 * Vive en este paquete mientras solo lo usan los prototipos (ADR-0009 §2).
 */
export function worstDrawdown(values: readonly number[]): {
  readonly drop: number;
  readonly at: number;
  readonly peak: number;
} {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = { drop: 0, at: 0, peak: 0 };
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    if (peak - v > worst.drop) {
      worst = { drop: peak - v, at: i, peak };
    }
  });
  return worst;
}
