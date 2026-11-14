// Dónde viven los datasets vivos de producción (ADR-0020 §5): un esquema propio de PostgreSQL, con
// su propia secuencia de migraciones, y un prefijo del bucket de la captura que la retención de los
// logs nunca toca (ADR-0018 §7).

/** El esquema de los datasets, de `buoh_dueno`. */
export const DATASETS_SCHEMA = 'buoh_datasets';

/** El prefijo de sus objetos en `buoh-captura`, con la regla de bloqueo `datasets-indefinido`. */
export const DATASETS_PREFIX = 'datasets/';
