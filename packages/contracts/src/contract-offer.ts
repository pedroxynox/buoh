import { z } from 'zod';

import {
  callputContractTypeSchema,
  contractDurationSchema,
  durationMagnitude,
  frameProvenanceFields,
  multiplierContractTypeSchema,
} from './batch-records.js';
import { symbolSchema } from './scalars.js';

/**
 * Un tipo de contrato que ofrece un mercado, de `contracts_for`, con los nombres de Deriv. En
 * sube/baja, la duración mínima y la máxima de un vencimiento. En los multiplicadores, solo que se
 * ofrecen: `contracts_for` publica multiplicadores que `proposal` no acepta (ADR-0021 §3), así que
 * no entran; qué multiplicadores se ofrecen lo dicen las cotizaciones (ADR-0024 §4).
 */
export const contractTypeOfferSchema = z.discriminatedUnion('contract_category', [
  z.strictObject({
    contract_category: z.literal('callput'),
    contract_type: callputContractTypeSchema,
    expiry_type: z.enum(['tick', 'intraday', 'daily']),
    min_contract_duration: contractDurationSchema,
    max_contract_duration: contractDurationSchema,
  }),
  z.strictObject({
    contract_category: z.literal('multiplier'),
    contract_type: multiplierContractTypeSchema,
    expiry_type: z.literal('no_expiry'),
  }),
]);

/**
 * `ContractOffer` 1.0.0 (contratos de dominio, «ContractOffer»; ADR-0024 §4): cuáles de los cuatro
 * tipos de contrato de buoh ofrece un símbolo, de una respuesta de `contracts_for`. Sin ninguno,
 * `offers` va vacía.
 */
export const contractOfferStructuralSchema = z
  .strictObject({
    schema_version: z.literal('1.0.0'),
    observation_id: frameProvenanceFields.observation_id,
    source: frameProvenanceFields.source,
    connector_version: frameProvenanceFields.connector_version,
    symbol: symbolSchema,
    offers: z.array(contractTypeOfferSchema),
    received_at_utc: frameProvenanceFields.received_at_utc,
    raw_payload_sha256: frameProvenanceFields.raw_payload_sha256,
  })
  .meta({ id: 'ContractOffer', title: 'ContractOffer' });

type ContractTypeOfferValue = z.infer<typeof contractTypeOfferSchema>;

/** Orden de `offers`: por `contract_type` y `expiry_type`, en unidades UTF-16 (el `<` de JavaScript). */
function precedes(left: ContractTypeOfferValue, right: ContractTypeOfferValue): boolean {
  return (
    left.contract_type < right.contract_type ||
    (left.contract_type === right.contract_type && left.expiry_type < right.expiry_type)
  );
}

export const contractOfferSchema = contractOfferStructuralSchema.superRefine((value, context) => {
  value.offers.forEach((offer, index) => {
    const previous = value.offers[index - 1];
    if (previous !== undefined && !precedes(previous, offer)) {
      context.addIssue({
        code: 'custom',
        message: 'offers va ordenada por contract_type y expiry_type, sin repetir la pareja.',
        path: ['offers', index],
      });
    }
    if (offer.contract_category !== 'callput') {
      return;
    }

    // El vencimiento `tick` se mide en ticks, y `intraday` y `daily`, en tiempo.
    const inTicks = offer.expiry_type === 'tick';
    const durations = [offer.min_contract_duration, offer.max_contract_duration];
    if (durations.some((duration) => (duration.duration_unit === 't') !== inTicks)) {
      context.addIssue({
        code: 'custom',
        message: inTicks
          ? 'Un vencimiento tick lleva sus duraciones en ticks (t).'
          : 'Un vencimiento intraday o daily lleva sus duraciones en tiempo (s, m, h o d).',
        path: ['offers', index],
      });
      return;
    }
    if (
      durationMagnitude(offer.min_contract_duration) >
      durationMagnitude(offer.max_contract_duration)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'min_contract_duration no puede pasar de max_contract_duration.',
        path: ['offers', index, 'min_contract_duration'],
      });
    }
  });
});

export type ContractTypeOffer = z.infer<typeof contractTypeOfferSchema>;
export type ContractOffer = z.infer<typeof contractOfferSchema>;
