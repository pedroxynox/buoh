/**
 * Datos de una cifra de desempeño, compartidos por web, móvil y escritorio. No dependen de React.
 */
/** De dónde sale una cifra de desempeño: prueba histórica o uno de los modos con resultados. */
export type EvidenceSource = 'backtest' | 'shadow' | 'demo' | 'real';

/**
 * Contexto obligatorio de toda cifra de desempeño (fundamentos de buoh, guía §3).
 * Los tipos impiden omitir campos al compilar; el contenido lo revisa quien lo escribe.
 */
export interface PerformanceContext {
  readonly source: EvidenceSource;
  readonly period: string;
  readonly sample: string;
  readonly costs: string;
  readonly losses: string;
  readonly drawdown: string;
  readonly version: string;
  readonly limitations: string;
}
