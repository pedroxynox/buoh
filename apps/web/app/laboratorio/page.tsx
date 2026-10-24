import { Badge, Card, MetricWithContext } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { EquityChart } from '../../src/components/Charts';
import {
  BACKTEST_CONTEXT,
  BACKTEST_SPLITS,
  equitySeries,
  LIFECYCLE_LABELS,
  STRATEGIES,
} from '../../src/fixtures';

export const metadata: Metadata = { title: 'Laboratorio' };

const LIFECYCLE_TONE = {
  draft: 'niebla',
  reviewed: 'cielo',
  active: 'aurora',
  paused: 'niebla',
  retired: 'niebla',
} as const;

export default function LaboratorioPage() {
  return (
    <>
      <PageHeader
        eyebrow="Laboratorio"
        title="¿Esta estrategia tiene evidencia?"
        summary="Cada estrategia es una versión inmutable. Se prueba con datos pasados separados en entrenamiento, validación y prueba fuera de muestra, con costes declarados."
      />

      <Card title="Estrategias" subtitle="Un cambio crea una versión nueva" headingLevel={2}>
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Estrategia</th>
                <th scope="col">Versión</th>
                <th scope="col">Ciclo de vida</th>
                <th scope="col">Símbolo</th>
                <th scope="col">Hipótesis</th>
              </tr>
            </thead>
            <tbody>
              {STRATEGIES.map((strategy) => (
                <tr key={`${strategy.name}-${strategy.version}`}>
                  <td>
                    <strong>{strategy.name}</strong>
                  </td>
                  <td className="b-num">{strategy.version}</td>
                  <td>
                    <Badge tone={LIFECYCLE_TONE[strategy.lifecycle]}>
                      {LIFECYCLE_LABELS[strategy.lifecycle]}
                    </Badge>
                  </td>
                  <td className="b-num">{strategy.symbol}</td>
                  <td className="b-secondary w-small">{strategy.hypothesis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="w-grid w-grid--wide">
        <Card
          title="Retorno a la media corta v3 · prueba fuera de muestra"
          subtitle="Resultado acumulado hipotético, en puntos porcentuales"
          headingLevel={2}
        >
          <EquityChart
            values={equitySeries()}
            label="Curva ficticia de resultado acumulado fuera de muestra, que termina ligeramente por debajo de cero"
          />
          <p className="b-muted w-small">
            La línea punteada es el cero. La marca roja es la peor caída desde un máximo.
          </p>
        </Card>
        <Card title="Evidencia" subtitle="La cifra nunca va sola">
          <MetricWithContext
            label="Resultado neto después de costes"
            value="−0,4 %"
            context={BACKTEST_CONTEXT}
          />
        </Card>
      </div>

      <Card
        title="Validación por tramos"
        subtitle="La ventaja de entrenamiento se reduce y desaparece fuera de muestra"
        headingLevel={2}
      >
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Tramo</th>
                <th scope="col">Período</th>
                <th scope="col">Muestra</th>
                <th scope="col">Resultado neto</th>
                <th scope="col">Drawdown máximo</th>
              </tr>
            </thead>
            <tbody>
              {BACKTEST_SPLITS.map((split) => (
                <tr key={split.name}>
                  <td>
                    <strong>{split.name}</strong>
                  </td>
                  <td>{split.period}</td>
                  <td>{split.sample}</td>
                  <td className="b-num">{split.result}</td>
                  <td className="b-num">{split.drawdown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="b-secondary w-small" style={{ marginTop: 'var(--b-space-4)' }}>
          Conclusión del ejemplo: la estrategia no pasa la puerta de validación. Un resultado
          negativo también es evidencia y queda registrado.
        </p>
      </Card>
    </>
  );
}
