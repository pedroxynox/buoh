import type { ExecutionMode } from '@buoh/contracts';

/**
 * El modo de ejecución que muestra la web servida por la API: `disabled`. Hasta F2.9 no existe ningún
 * componente que emita señales, así que ninguna se convierte en intención y nada sale al bróker
 * (concepto de interfaz §10). No sale de la salud de los datos: son ejes distintos, y el modo no
 * desaparece cuando la salud no se puede leer. El `HealthReport` dice lo mismo, porque su
 * `execution_mode` solo admite `disabled`. Desde F2.9 lo da el motor de señales.
 */
export const API_EXECUTION_MODE: ExecutionMode = 'disabled';
