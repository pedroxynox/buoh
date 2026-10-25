import { describe, expect, it } from 'vitest';
import { worstDrawdown } from '../src/components/Charts';
import {
  APPROVED_VALIDATION,
  AUDIT,
  BACKTEST_CONTEXT,
  BACKTEST_SPLITS,
  DEMO_NOW_UTC,
  equitySeries,
  GLOBAL_STATUS,
  INCIDENTS,
  INSTRUMENTS,
  instrumentsOf,
  priceSeries,
  PRICE_GAPS,
  r100TickTimeUtc,
  R100_TICK_SECONDS,
  SHADOW_CONTEXT,
  SHADOW_PERIOD_START_UTC,
  SIGNALS,
  SOURCES,
  SPLITS_CONTEXT,
  STRATEGIES,
} from '../src/fixtures';
import { formatUtc } from '../src/format';

const now = Date.parse(DEMO_NOW_UTC);

describe('datos ficticios coherentes (V1-UI-001)', () => {
  it('una condición abierta impide que su fuente y la salud global sean «healthy»', () => {
    const open = INCIDENTS.filter((incident) => incident.status === 'abierta');
    expect(open.length).toBeGreaterThan(0);
    for (const incident of open) {
      const source = SOURCES.find((s) => s.name === incident.source);
      expect(source?.health, incident.source).not.toBe('healthy');
    }
    expect(GLOBAL_STATUS.health).not.toBe('healthy');
    const unhealthy = SOURCES.filter((s) => s.health !== 'healthy');
    expect(unhealthy).toHaveLength(1);
    expect(GLOBAL_STATUS.health).toBe(unhealthy[0]?.health);
  });

  it('un hueco sin resolver corresponde a una salud degradada (contratos, «Salud derivada»)', () => {
    for (const incident of INCIDENTS) {
      if (incident.type === 'event_gap_unresolved' && incident.status === 'abierta') {
        expect(SOURCES.find((s) => s.name === incident.source)?.health).toBe('degraded');
      }
    }
  });

  it('solo una estrategia aprobada y activa emite señales vigentes, y nunca antes de su aprobación', () => {
    for (const signal of SIGNALS) {
      const strategy = STRATEGIES.find((s) => s.id === signal.strategyId);
      expect(strategy, signal.id).toBeDefined();
      expect(strategy?.approvedForShadowUtc, signal.id).not.toBeNull();
      expect(Date.parse(signal.issuedUtc)).toBeGreaterThan(
        Date.parse(strategy?.approvedForShadowUtc ?? ''),
      );
      if (signal.status === 'vigente') {
        expect(strategy?.lifecycle).toBe('active');
        expect(signal.quality).toBe('completa');
      }
    }
  });

  it('el estado de cada señal coincide con el instante de referencia', () => {
    for (const signal of SIGNALS) {
      const issued = Date.parse(signal.issuedUtc);
      const expires = Date.parse(signal.expiresUtc);
      expect(expires).toBeGreaterThan(issued);
      expect(issued).toBeLessThanOrEqual(now);
      if (signal.status === 'vigente') {
        expect(now).toBeLessThan(expires);
      } else {
        expect(now).toBeGreaterThanOrEqual(expires);
      }
    }
    const times = SIGNALS.map((s) => Date.parse(s.issuedUtc));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('una señal con datos degradados nunca queda vigente', () => {
    for (const signal of SIGNALS.filter((s) => s.quality === 'degradada')) {
      expect(signal.status).toBe('descartada');
    }
  });

  it('una estrategia que no pasó la validación no tiene aprobación ni señales', () => {
    for (const strategy of STRATEGIES.filter((s) => s.approvedForShadowUtc === null)) {
      expect(strategy.lifecycle).toBe('retired');
      expect(SIGNALS.some((signal) => signal.strategyId === strategy.id)).toBe(false);
    }
    const lastSplit = BACKTEST_SPLITS.at(-1);
    expect(lastSplit?.result).toContain('pérdida');
    expect(SPLITS_CONTEXT.version).toBe(BACKTEST_CONTEXT.version);
    expect(
      STRATEGIES.find((s) => `${s.name} ${s.version}` === SPLITS_CONTEXT.version)?.lifecycle,
    ).toBe('retired');
  });

  it('el período shadow empieza con la aprobación, después de su propia prueba fuera de muestra', () => {
    const approved = STRATEGIES.find((s) => `${s.name} ${s.version}` === SHADOW_CONTEXT.version);
    expect(approved?.approvedForShadowUtc).toBe(SHADOW_PERIOD_START_UTC);
    expect(AUDIT.some((row) => row.whenUtc === SHADOW_PERIOD_START_UTC)).toBe(true);
    for (const strategy of STRATEGIES.filter((s) => s.approvedForShadowUtc !== null)) {
      const evidence = APPROVED_VALIDATION.find((v) => v.strategyId === strategy.id);
      expect(evidence, strategy.id).toBeDefined();
      expect(evidence?.version).toBe(`${strategy.name} ${strategy.version}`);
      expect(Date.parse(strategy.approvedForShadowUtc ?? '')).toBeGreaterThan(
        Date.parse(evidence?.windowEndUtc ?? ''),
      );
      expect(Date.parse(strategy.registeredUtc)).toBeLessThan(Date.parse('2026-07-01T00:00:00Z'));
    }
  });

  it('cada señal coincide con su estrategia y enlaza a evidencia existente', () => {
    for (const signal of SIGNALS) {
      const strategy = STRATEGIES.find((s) => s.id === signal.strategyId);
      expect(signal.strategy).toBe(strategy?.name);
      expect(signal.version).toBe(strategy?.version);
      expect(signal.symbol).toBe(strategy?.symbol);
      expect(signal.evidenceHref).toMatch(/^\/[a-z]+\/(#[a-z0-9-]+)?$/);
      const anchor = signal.evidenceHref.split('#')[1];
      if (anchor !== undefined) {
        expect(APPROVED_VALIDATION.map((v) => `evidencia-${v.strategyId}`)).toContain(anchor);
      }
    }
  });

  it('una estrategia en pausa no emite señales después de su pausa', () => {
    for (const strategy of STRATEGIES.filter((s) => s.lifecycle === 'paused')) {
      expect(strategy.pausedUtc, strategy.id).toBeDefined();
      for (const signal of SIGNALS.filter((s) => s.strategyId === strategy.id)) {
        expect(Date.parse(signal.issuedUtc)).toBeLessThan(Date.parse(strategy.pausedUtc ?? ''));
      }
    }
  });

  it('una señal solo se marca con datos degradados si se emitió con una condición abierta', () => {
    const opened = Math.min(
      ...INCIDENTS.filter((i) => i.status !== 'registrada').map((i) => Date.parse(i.whenUtc)),
    );
    for (const signal of SIGNALS) {
      if (Date.parse(signal.issuedUtc) < opened) {
        expect(signal.quality, signal.id).toBe('completa');
      }
    }
  });

  it('las métricas y los tramos traen todo su contexto, sin campos vacíos', () => {
    for (const context of [BACKTEST_CONTEXT, SHADOW_CONTEXT]) {
      for (const [field, value] of Object.entries(context)) {
        expect(String(value).trim().length, field).toBeGreaterThan(0);
      }
    }
    for (const split of BACKTEST_SPLITS) {
      for (const [field, value] of Object.entries(split) as [string, string][]) {
        expect(value.trim().length, `${split.name}.${field}`).toBeGreaterThan(0);
      }
    }
    for (const value of Object.values(SPLITS_CONTEXT)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('las pérdidas declaradas cuadran con su muestra', () => {
    const ratio = (losses: string) => {
      const match = /^([\d\u00a0]+)[^(]*\(([\d,]+)/.exec(losses);
      return match === null
        ? null
        : { n: Number(match[1]?.replace(/\u00a0/g, '')), pct: Number(match[2]?.replace(',', '.')) };
    };
    for (const split of BACKTEST_SPLITS) {
      const sample = Number(split.sample.replace(/\D/g, ''));
      const r = ratio(split.losses);
      expect(r).not.toBeNull();
      expect(((r?.n ?? 0) / sample) * 100).toBeCloseTo(r?.pct ?? 0, 1);
    }
  });

  it('la curva de capital coincide con su contexto: termina en −0,4 y cae 3,6 como máximo', () => {
    const values = equitySeries();
    expect(values.at(-1)).toBe(-0.4);
    expect(worstDrawdown(values).drop.toFixed(1)).toBe('3.6');
    expect(BACKTEST_CONTEXT.drawdown).toBe('−3,6\u00a0%');
  });

  it('el hueco del gráfico coincide con la incidencia y la conexión perdida', () => {
    const values = priceSeries();
    const lost = INCIDENTS.find((i) => i.type === 'connection_lost');
    const unresolved = INCIDENTS.find((i) => i.type === 'event_gap_unresolved');
    expect(PRICE_GAPS).toHaveLength(1);
    for (const gap of PRICE_GAPS) {
      for (let i = gap.start; i < gap.end; i += 1) {
        expect(values[i]).toBeNull();
      }
      expect(values[gap.start - 1]).not.toBeNull();
      expect(values[gap.end]).not.toBeNull();
      expect(Date.parse(r100TickTimeUtc(gap.start - 1))).toBeLessThanOrEqual(
        Date.parse(lost?.whenUtc ?? ''),
      );
      expect(r100TickTimeUtc(gap.end)).toBe(unresolved?.whenUtc);
    }
    expect(R100_TICK_SECONDS).toBe(2);
    expect(Date.parse(r100TickTimeUtc(values.length - 1))).toBeLessThanOrEqual(now);
    expect(priceSeries()).toEqual(values);
  });

  it('los conteos por fuente salen del catálogo y todo instrumento dice su contexto', () => {
    expect(SOURCES.map((s) => instrumentsOf(s.name))).toEqual([3, 1, 1]);
    for (const instrument of INSTRUMENTS) {
      expect(instrument.source.length).toBeGreaterThan(0);
      expect(instrument.cadence.length).toBeGreaterThan(0);
      expect(instrument.freshness.length).toBeGreaterThan(0);
      expect(instrument.quality.label.length).toBeGreaterThan(0);
    }
  });

  it('el prototipo no muestra señales en demo ni en real antes de su fase', () => {
    expect(SIGNALS.every((signal) => signal.mode === 'shadow')).toBe(true);
  });

  it('las fechas se muestran en UTC sin depender del equipo', () => {
    expect(formatUtc('2026-10-20T14:32:05.000Z')).toBe('20 oct 2026, 14:32:05 UTC');
  });
});
