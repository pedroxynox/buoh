import { deploymentEnvironmentSchema } from '@buoh/contracts';
import { z } from 'zod';

/** Los entornos de la API: en la Fase 2 no hay `staging` (plan de Fase 2, §4, punto 9). */
const apiEnvironmentSchema = deploymentEnvironmentSchema.exclude(['staging']);

/** Render da a cada servicio web su puerto en `PORT`, y 10000 si no lo cambia. */
export const DEFAULT_PORT = 10_000;

const PORT_PATTERN = /^[1-9]\d{0,4}$/u;

const environmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: apiEnvironmentSchema,
  PORT: z
    .string()
    .regex(PORT_PATTERN)
    .refine((value) => Number(value) <= 65_535)
    .optional(),
});

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

/** La configuración de la API (ADR-0019 §10). Las credenciales llegan con los PR que las usan. */
export interface ApiConfig {
  readonly environment: ApiEnvironment;
  /** `0.0.0.0` en `production`, donde Render envía el tráfico a la instancia; si no, `127.0.0.1`. */
  readonly host: string;
  readonly port: number;
}

/** Una configuración inválida o ausente: los nombres de las variables, nunca sus valores. */
export class ApiConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Configuración inválida o ausente: ${variables.join(', ')}.`);
    this.name = 'ApiConfigError';
    this.variables = variables;
  }
}

/**
 * Lee la configuración de `env`. `BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria y no admite
 * `staging`. Una variable inválida o ausente lanza `ApiConfigError` con los nombres de todas las
 * rechazadas, ordenados.
 */
export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const rejected = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    throw new ApiConfigError([...rejected].sort());
  }
  const environment = parsed.data.BUOH_DEPLOYMENT_ENVIRONMENT;
  return {
    environment,
    host: environment === 'production' ? '0.0.0.0' : '127.0.0.1',
    port: parsed.data.PORT === undefined ? DEFAULT_PORT : Number(parsed.data.PORT),
  };
}
