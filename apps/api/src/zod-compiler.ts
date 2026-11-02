import type { FastifySchemaCompiler, FastifySerializerCompiler } from 'fastify';
import type { ZodType } from 'zod';

/**
 * Una entrada que no cumple su contrato. Fastify le pone el estado 400 y el código
 * `FST_ERR_VALIDATION`, y la API responde `invalid_request`. Su mensaje es fijo y nunca sale.
 */
export class RequestContractError extends Error {
  constructor() {
    super('La petición no cumple su contrato.');
    this.name = 'RequestContractError';
  }
}

/** Una salida que no cumple su contrato: la API responde `internal`, nunca una respuesta a medias. */
export class ResponseContractError extends Error {
  constructor() {
    super('La respuesta no cumple su contrato.');
    this.name = 'ResponseContractError';
  }
}

/**
 * El compilador de validación de Fastify con los esquemas de Zod de `packages/contracts`
 * (ADR-0019 §6): la entrada que llega a la ruta es la que devuelve el esquema.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    return result.success ? { value: result.data } : { error: new RequestContractError() };
  };

/** El compilador de serialización: cada salida pasa por su esquema antes de convertirse en JSON. */
export const zodSerializerCompiler: FastifySerializerCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ResponseContractError();
    }
    return JSON.stringify(result.data);
  };
