import { deploymentEnvironmentSchema } from '@buoh/contracts';
import type { z } from 'zod';

/** Los entornos de la API: en la Fase 2 no hay `staging` (plan de Fase 2, §4, punto 9). */
export const apiEnvironmentSchema = deploymentEnvironmentSchema.exclude(['staging']);

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

/** Una configuración inválida o ausente: los nombres de las variables, nunca sus valores. */
export class ApiConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Configuración inválida o ausente: ${variables.join(', ')}.`);
    this.name = 'ApiConfigError';
    this.variables = variables;
  }
}
