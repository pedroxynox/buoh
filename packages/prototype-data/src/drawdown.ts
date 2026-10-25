/** Mayor caída desde un máximo previo, en las mismas unidades que la serie. */
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
