import { z } from 'zod';

import { frameProvenanceFields } from './batch-records.js';
import { symbolSchema, utcTimestampMsSchema } from './scalars.js';

const DAY_MS = 86_400_000;

/** Un día UTC `AAAA-MM-DD` que existe en el calendario, como el que se pide a `trading_times`. */
export const tradingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Debe ser un día UTC real.');

/** Un intervalo en que el símbolo cotiza: desde `opens_at_utc`, incluido, hasta `closes_at_utc`, sin incluir. */
export const tradingIntervalSchema = z.strictObject({
  opens_at_utc: utcTimestampMsSchema,
  closes_at_utc: utcTimestampMsSchema,
});

/**
 * `TradingSession` 1.0.0 (contratos de dominio, «TradingSession»; ADR-0021 §4 y ADR-0024 §4): el
 * horario de un símbolo en un día UTC, de una respuesta de `trading_times`. Sin intervalos, ese día
 * no cotiza. Un cierre `23:59:59` de Deriv es el fin del día, y se guarda como las 00:00 del día
 * siguiente.
 */
export const tradingSessionStructuralSchema = z
  .strictObject({
    schema_version: z.literal('1.0.0'),
    observation_id: frameProvenanceFields.observation_id,
    source: frameProvenanceFields.source,
    connector_version: frameProvenanceFields.connector_version,
    symbol: symbolSchema,
    trading_date: tradingDateSchema,
    intervals: z.array(tradingIntervalSchema),
    received_at_utc: frameProvenanceFields.received_at_utc,
    raw_payload_sha256: frameProvenanceFields.raw_payload_sha256,
  })
  .meta({ id: 'TradingSession', title: 'TradingSession' });

export const tradingSessionSchema = tradingSessionStructuralSchema.superRefine((value, context) => {
  const dayStart = Date.parse(`${value.trading_date}T00:00:00.000Z`);
  const dayEnd = dayStart + DAY_MS;
  let previousClose: number | null = null;

  value.intervals.forEach((interval, index) => {
    const opens = Date.parse(interval.opens_at_utc);
    const closes = Date.parse(interval.closes_at_utc);
    if (opens < dayStart || closes > dayEnd) {
      context.addIssue({
        code: 'custom',
        message: 'Cada intervalo va dentro de trading_date, hasta las 00:00 del día siguiente.',
        path: ['intervals', index],
      });
    }
    if (closes <= opens) {
      context.addIssue({
        code: 'custom',
        message: 'closes_at_utc debe ser posterior a opens_at_utc.',
        path: ['intervals', index, 'closes_at_utc'],
      });
    }
    // En orden, sin solaparse ni tocarse: dos intervalos seguidos serían uno.
    if (previousClose !== null && opens <= previousClose) {
      context.addIssue({
        code: 'custom',
        message: 'Los intervalos van en orden, sin solaparse ni tocarse.',
        path: ['intervals', index, 'opens_at_utc'],
      });
    }
    previousClose = closes;
  });
});

export type TradingInterval = z.infer<typeof tradingIntervalSchema>;
export type TradingSession = z.infer<typeof tradingSessionSchema>;
