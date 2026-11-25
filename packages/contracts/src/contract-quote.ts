import { z } from 'zod';

import {
  callputContractTypeSchema,
  contractDurationSchema,
  frameProvenanceFields,
  isNonNegativeDecimal,
  isPositiveDecimal,
  multiplierContractTypeSchema,
} from './batch-records.js';
import { decimalStringSchema, symbolSchema, utcTimestampMsSchema } from './scalars.js';

const quoteFields = {
  schema_version: z.literal('1.0.0'),
  observation_id: frameProvenanceFields.observation_id,
  source: frameProvenanceFields.source,
  connector_version: frameProvenanceFields.connector_version,
  symbol: symbolSchema,
  currency: z.literal('USD'),
  stake_decimal: decimalStringSchema,
  quoted_at_utc: utcTimestampMsSchema,
  ask_price_decimal: decimalStringSchema,
  received_at_utc: frameProvenanceFields.received_at_utc,
  raw_payload_sha256: frameProvenanceFields.raw_payload_sha256,
};

/**
 * `ContractQuote` 1.0.0 (contratos de dominio, «ContractQuote»; ADR-0021 §4): lo que Deriv ofrecía
 * por un contrato en un instante, de una respuesta de `proposal` sin cuenta. El contrato pedido sale
 * de `echo_req`; lo cotizado, de `proposal`. Un sube/baja lleva su duración y su pago, y un
 * multiplicador, su multiplicador y su comisión. `quoted_at_utc` es `spot_time`.
 */
export const contractQuoteStructuralSchema = z
  .discriminatedUnion('contract_category', [
    z.strictObject({
      ...quoteFields,
      contract_category: z.literal('callput'),
      contract_type: callputContractTypeSchema,
      duration: contractDurationSchema,
      payout_decimal: decimalStringSchema,
    }),
    z.strictObject({
      ...quoteFields,
      contract_category: z.literal('multiplier'),
      contract_type: multiplierContractTypeSchema,
      multiplier_decimal: decimalStringSchema,
      commission_decimal: decimalStringSchema,
    }),
  ])
  .meta({ id: 'ContractQuote', title: 'ContractQuote' });

export const contractQuoteSchema = contractQuoteStructuralSchema.superRefine((value, context) => {
  const amounts: [string, string][] = [['ask_price_decimal', value.ask_price_decimal]];
  if (value.contract_category === 'callput') {
    amounts.push(['payout_decimal', value.payout_decimal]);
  } else {
    amounts.push(['commission_decimal', value.commission_decimal]);
  }
  for (const [field, amount] of amounts) {
    if (!isNonNegativeDecimal(amount)) {
      context.addIssue({
        code: 'custom',
        message: `${field} no puede ser negativo.`,
        path: [field],
      });
    }
  }

  const positives: [string, string][] = [['stake_decimal', value.stake_decimal]];
  if (value.contract_category === 'multiplier') {
    positives.push(['multiplier_decimal', value.multiplier_decimal]);
  }
  for (const [field, amount] of positives) {
    if (!isPositiveDecimal(amount)) {
      context.addIssue({
        code: 'custom',
        message: `${field} debe ser mayor que cero.`,
        path: [field],
      });
    }
  }
});

export type ContractQuote = z.infer<typeof contractQuoteSchema>;
