import { Badge, Card, HealthBadge } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { PriceChart } from '../../src/components/Charts';
import { DataMeta } from '../../src/components/Pieces';
import { INSTRUMENTS, PRICE_GAPS, priceSeries, SOURCES } from '../../src/fixtures';

export const metadata: Metadata = { title: 'Mercados' };

export default function MercadosPage() {
  return (
    <>
      <PageHeader
        eyebrow="Mercados"
        title="¿Qué sigo y qué tan buenos son sus datos?"
        summary="Catálogo por fuente con los nombres oficiales sin reinterpretar. Cada fuente se guarda por separado: el mismo nombre en dos fuentes no es el mismo instrumento."
      />

      <Card
        title="Volatility 100 Index (ejemplo)"
        subtitle="Ticks de los últimos 3 minutos"
        actions={
          <Badge tone="naranja" icon="gap">
            1 hueco visible
          </Badge>
        }
        headingLevel={2}
      >
        <DataMeta
          items={[
            [
              'Símbolo',
              <span key="s" className="b-num">
                R_100
              </span>,
            ],
            ['Fuente', 'Deriv · WebSocket público'],
            ['Zona horaria', 'UTC'],
            ['Intervalo', '1 tick por segundo'],
            ['Frescura', 'hace 1 s'],
            [
              'Calidad',
              <Badge key="q" tone="naranja" icon="alertTriangle">
                Hueco sin resolver
              </Badge>,
            ],
          ]}
        />
        <PriceChart
          values={priceSeries()}
          gaps={PRICE_GAPS}
          label="Precio ficticio de Volatility 100 durante 180 segundos, con un hueco de 13 segundos marcado"
        />
        <p className="b-muted w-small">
          El hueco no se rellena ni se suaviza: se dibuja como un corte y conserva su motivo.
        </p>
      </Card>

      <Card title="Catálogo" subtitle="Instrumentos seguidos, por fuente" headingLevel={2}>
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Símbolo oficial</th>
                <th scope="col">Nombre</th>
                <th scope="col">Fuente</th>
                <th scope="col">Cadencia</th>
                <th scope="col">Último precio</th>
                <th scope="col">Frescura</th>
                <th scope="col">Horario</th>
                <th scope="col">Calidad</th>
              </tr>
            </thead>
            <tbody>
              {INSTRUMENTS.map((instrument) => (
                <tr key={`${instrument.source}-${instrument.symbol}`}>
                  <td className="b-num">{instrument.symbol}</td>
                  <td>{instrument.name}</td>
                  <td>{instrument.source}</td>
                  <td>{instrument.cadence}</td>
                  <td className="b-num">{instrument.lastPrice}</td>
                  <td>{instrument.freshness}</td>
                  <td>{instrument.schedule}</td>
                  <td>
                    <Badge tone={instrument.quality.tone}>{instrument.quality.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="w-grid w-grid--3">
        {SOURCES.map((source) => (
          <Card key={source.id} title={source.name} subtitle={source.kind}>
            <div className="w-stack">
              <HealthBadge health={source.health} showDescription />
              <p className="b-secondary w-small">
                {String(source.instruments)} instrumentos en el catálogo.
              </p>
              {source.phase === '1' ? null : (
                <p className="w-row b-muted w-small">
                  <Badge tone="niebla">Fase {source.phase}</Badge> La captura real de MetaTrader 5
                  llega en esa fase.
                </p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
