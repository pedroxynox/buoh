import { Badge, Card, EvidenceSourceBadge, MetricWithContext } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { EquityChart } from '../../src/components/Charts';
import { DataMeta } from '../../src/components/Pieces';
import {
  APPROVED_VALIDATION,
  BACKTEST_CONTEXT,
  BACKTEST_SPLITS,
  EQUITY_TIME_LABELS,
  equitySeries,
  LIFECYCLE_PRESENTATION,
  SPLITS_CONTEXT,
  STRATEGIES,
} from '../../src/fixtures';
import { formatUtc } from '../../src/format';

export const metadata: Metadata = { title: 'Laboratorio' };

export default function LaboratorioPage() {
  return (
    <>
      <PageHeader
        eyebrow="Laboratorio"
        title="¿Esta estrategia tiene evidencia?"
        summary="Cada estrategia es una versión inmutable. Se prueba con datos pasados separados en entrenamiento, validación y prueba fuera de muestra, con costes declarados. Solo una versión que supera esos tramos y una réplica independiente llega a shadow."
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
                <th scope="col">Aprobada para shadow</th>
              </tr>
            </thead>
            <tbody>
              {STRATEGIES.map((strategy) => {
                const lifecycle = LIFECYCLE_PRESENTATION[strategy.lifecycle];
                return (
                  <tr key={strategy.id}>
                    <td>
                      <strong>{strategy.name}</strong>
                    </td>
                    <td className="b-num">{strategy.version}</td>
                    <td>
                      <Badge tone={lifecycle.tone} icon={lifecycle.icon}>
                        {lifecycle.label}
                      </Badge>
                    </td>
                    <td className="b-num">{strategy.symbol}</td>
                    <td className="b-secondary w-small">
                      {strategy.hypothesis}
                      <br />
                      <span className="b-muted">{strategy.note}</span>
                    </td>
                    <td className="b-num w-small">
                      {strategy.approvedForShadowUtc === null
                        ? 'No'
                        : formatUtc(strategy.approvedForShadowUtc)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Estrategias aprobadas · prueba fuera de muestra"
        subtitle="La evidencia que permitió su paso a shadow"
        headingLevel={2}
      >
        <DataMeta
          items={[
            ['Origen', <EvidenceSourceBadge key="o" source={SPLITS_CONTEXT.source} />],
            ['Costes', SPLITS_CONTEXT.costs],
          ]}
        />
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Versión</th>
                <th scope="col">Período</th>
                <th scope="col">Muestra</th>
                <th scope="col">Resultado neto</th>
                <th scope="col">Pérdidas</th>
                <th scope="col">Drawdown máximo</th>
              </tr>
            </thead>
            <tbody>
              {APPROVED_VALIDATION.map((row) => (
                <tr key={row.strategyId} id={`evidencia-${row.strategyId}`}>
                  <td>
                    <strong>{row.version}</strong>
                  </td>
                  <td>{row.window}</td>
                  <td>{row.sample}</td>
                  <td className="b-num">{row.result}</td>
                  <td>{row.losses}</td>
                  <td className="b-num">{row.drawdown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="b-metric__limits" style={{ marginTop: 'var(--b-space-4)' }}>
          <strong>Limitaciones:</strong> {SPLITS_CONTEXT.limitations} Las tres hipótesis se
          registraron el 28 jun 2026, antes de ver cualquier tramo de prueba.
        </p>
      </Card>

      <div className="w-grid w-grid--wide">
        <Card
          title="Retorno a la media corta v3 · prueba fuera de muestra"
          subtitle="Resultado acumulado hipotético, en puntos porcentuales"
          headingLevel={2}
        >
          <EquityChart
            values={equitySeries()}
            timeLabels={EQUITY_TIME_LABELS}
            label="Curva ficticia de resultado acumulado del 1 al 15 de octubre, que termina en −0,4 puntos, con una peor caída de 3,6 puntos"
          />
          <p className="b-muted w-small">
            La línea punteada es el cero. La marca roja es la peor caída desde un máximo.
          </p>
        </Card>
        <Card title="Evidencia" subtitle="La cifra nunca va sola">
          <MetricWithContext
            label="Pérdida neta después de costes"
            value="−0,4 %"
            context={BACKTEST_CONTEXT}
          />
        </Card>
      </div>

      <Card
        title="Validación por tramos"
        subtitle="La ventaja de entrenamiento se reduce y se convierte en pérdida fuera de muestra"
        headingLevel={2}
      >
        <DataMeta
          items={[
            ['Origen', <EvidenceSourceBadge key="o" source={SPLITS_CONTEXT.source} />],
            ['Costes', SPLITS_CONTEXT.costs],
            ['Versión', SPLITS_CONTEXT.version],
          ]}
        />
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Tramo</th>
                <th scope="col">Período</th>
                <th scope="col">Muestra</th>
                <th scope="col">Resultado neto</th>
                <th scope="col">Pérdidas</th>
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
                  <td>{split.losses}</td>
                  <td className="b-num">{split.drawdown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="b-metric__limits" style={{ marginTop: 'var(--b-space-4)' }}>
          <strong>Limitaciones:</strong> {SPLITS_CONTEXT.limitations}
        </p>
        <p className="b-secondary w-small" style={{ marginTop: 'var(--b-space-2)' }}>
          Conclusión del ejemplo: la estrategia no pasa la puerta de validación y se retira; nunca
          llega a shadow. Un resultado negativo también es evidencia y queda registrado.
        </p>
      </Card>
    </>
  );
}
