/**
 * Contenido del sitio oficial (V1-SITE-001, ADR-0008 §3). Describe qué es buoh, cómo trabaja y en qué
 * estado está. No promete ganancias, no publica resultados, no capta usuarios y no vende señales.
 * Las fases deben coincidir con docs/producto/roadmap.md; una prueba lo comprueba.
 */
import type { IconName } from '@buoh/design-system';

export interface SitePage {
  readonly href: string;
  readonly label: string;
}

export const PAGES: readonly SitePage[] = [
  { href: '/', label: 'Inicio' },
  { href: '/como-funciona/', label: 'Cómo funciona' },
  { href: '/principios/', label: 'Principios' },
  { href: '/plataformas/', label: 'Plataformas' },
  { href: '/hoja-de-ruta/', label: 'Hoja de ruta' },
  { href: '/aviso-de-riesgo/', label: 'Aviso de riesgo' },
];

export const TAGLINE = 'Observa con calma. Decide con evidencia.';

/**
 * Entrega siguiente de PROJECT_STATUS.md para la que se escribió el texto sobre lo que existe hoy.
 * Una prueba falla cuando cambia, para obligar a revisar el sitio.
 */
export const WRITTEN_FOR_NEXT_DELIVERY = 'F1.4b';

/** Aviso corto que va en el pie de todas las páginas. */
export const RISK_SHORT =
  'Operar opciones y CFD implica un riesgo alto de perder dinero. Ningún resultado pasado, simulado o de práctica asegura resultados futuros. buoh no da asesoramiento financiero.';

export const TRADEMARK_NOTE =
  'Deriv y Vantage son marcas de sus titulares, y MetaTrader 5 es marca de MetaQuotes. buoh no está afiliado a ninguno de ellos ni cuenta con su respaldo; los nombra solo para describir integraciones previstas.';

export interface Plane {
  readonly name: string;
  readonly icon: IconName;
  readonly summary: string;
  readonly never: string;
}

export const PLANES: readonly Plane[] = [
  {
    name: 'Investigación',
    icon: 'flask',
    summary:
      'Datos con procedencia, hipótesis versionadas y pruebas separadas en entrenamiento, validación y fuera de muestra.',
    never: 'Nunca envía órdenes.',
  },
  {
    name: 'Señales',
    icon: 'radar',
    summary:
      'Cada señal dirá qué estrategia y versión la emitió, cuándo vence, en qué modo está y con qué calidad de datos.',
    never: 'Una señal no es una orden.',
  },
  {
    name: 'Ejecución',
    icon: 'send',
    summary:
      'Un servicio aislado en el servidor aplicará la política de riesgo, registrará cada intento y lo comparará con el bróker.',
    never: 'Ninguna pantalla envía órdenes por su cuenta.',
  },
];

export interface Step {
  readonly title: string;
  readonly text: string;
}

export const CYCLE: readonly Step[] = [
  {
    title: 'Capturar',
    text: 'Se guarda cada mensaje de la fuente tal como llegó, con su hora de recepción, antes de interpretarlo.',
  },
  {
    title: 'Revisar la calidad',
    text: 'Huecos, retrasos, duplicados y datos fuera de orden se registran y se muestran. Nada se rellena ni se esconde.',
  },
  {
    title: 'Investigar',
    text: 'Una hipótesis se prueba con costes declarados y con datos que no vio al diseñarse.',
  },
  {
    title: 'Observar en shadow',
    text: 'La estrategia aprobada emite señales hipotéticas con datos vivos, sin dinero, y se compara con lo esperado.',
  },
  {
    title: 'Practicar en demo',
    text: 'Con dinero de práctica, cada orden se registra, se controla y se reconcilia con el bróker.',
  },
  {
    title: 'Real, solo si se aprueba',
    text: 'Una cuenta, una estrategia y unos límites concretos, después de una evaluación estadística, técnica, operativa y legal.',
  },
];

export interface Mode {
  readonly mode: 'disabled' | 'shadow' | 'demo' | 'real';
  readonly meaning: string;
  readonly phase: string;
}

export const MODES: readonly Mode[] = [
  {
    mode: 'disabled',
    meaning: 'Ninguna señal se convierte en intención.',
    phase: 'Siempre disponible',
  },
  {
    mode: 'shadow',
    meaning: 'Señales y posiciones hipotéticas. Nada sale al bróker.',
    phase: 'Fase 2',
  },
  {
    mode: 'demo',
    meaning: 'Órdenes con dinero de práctica, controladas y reconciliadas.',
    phase: 'Fase 4',
  },
  { mode: 'real', meaning: 'Órdenes con dinero real, solo en lo aprobado.', phase: 'Fase 6' },
];

export interface Principle {
  readonly title: string;
  readonly text: string;
  readonly icon: IconName;
}

export const PRINCIPLES: readonly Principle[] = [
  {
    title: 'Evidencia antes que promesas',
    text: 'Toda cifra de desempeño va con su modo, período, muestra, costes, pérdidas, caída máxima, versión y limitaciones. Una tasa de acierto sola no prueba nada.',
    icon: 'book',
  },
  {
    title: 'Los datos no se maquillan',
    text: 'El dato crudo no se reescribe. Un hueco se marca como hueco. Una incidencia queda registrada aunque se resuelva.',
    icon: 'database',
  },
  {
    title: 'Los resultados negativos también cuentan',
    text: 'Una estrategia que pierde fuera de muestra se retira y su evidencia se conserva. Ocultarla sería engañarse.',
    icon: 'chart',
  },
  {
    title: 'Señal y orden son cosas distintas',
    text: 'Investigar, emitir señales y ejecutar son planos separados. Pasar de uno a otro exige una puerta explícita.',
    icon: 'layers',
  },
  {
    title: 'Detener siempre está a mano',
    text: 'Un interruptor de emergencia podrá detener todo desde cualquier plataforma. Operar, en cambio, nunca depende de una pantalla.',
    icon: 'power',
  },
  {
    title: 'Calma, no urgencia',
    text: 'Sin contadores, sin parpadeos y sin presión. buoh se diseña como un observatorio nocturno, no como un casino.',
    icon: 'moon',
  },
];

export const NEVER: readonly string[] = [
  'Prometer ganancias o presentar una hipótesis como certeza.',
  'Recibir depósitos, hacer retiros o custodiar dinero de nadie.',
  'Pedir la contraseña de tu cuenta Deriv o contraseñas de terceros.',
  'Enviar órdenes desde una página web, un móvil, una aplicación de escritorio o una capa flotante.',
  'Leer tu pantalla o manejar otras aplicaciones por ti.',
  'Operar en mercados, países o cuentas que no se hayan aprobado explícitamente.',
];

export interface PlatformInfo {
  readonly name: string;
  readonly icon: IconName;
  readonly role: string;
  readonly phase: string;
}

export const PLATFORMS: readonly PlatformInfo[] = [
  {
    name: 'Web',
    icon: 'eye',
    role: 'La estación principal: investigación, señales, auditoría y configuración.',
    phase: 'Fase 2 (hoy, prototipo con datos ficticios)',
  },
  {
    name: 'Android e iOS',
    icon: 'radar',
    role: 'Seguir el bot: estado, señales, alertas, evidencia y autorizaciones seguras.',
    phase: 'Fase 3',
  },
  {
    name: 'Windows',
    icon: 'layers',
    role: 'La misma estación de la web como aplicación instalada.',
    phase: 'Fase 7',
  },
];

export interface Integration {
  readonly name: string;
  readonly what: string;
  readonly phase: string;
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    name: 'Deriv',
    what: 'Primera fuente: datos públicos de índices sintéticos, sin cuenta ni contraseña. Más adelante, opciones en demo.',
    phase: 'Datos en Fase 1; demo en Fase 4',
  },
  {
    name: 'MetaTrader 5 · Deriv MT5',
    what: 'Precios de compra y venta por un puente dentro de la terminal MT5. Más adelante, CFD en demo.',
    phase: 'Datos en Fase 1B; demo en Fase 4',
  },
  {
    name: 'MetaTrader 5 · Vantage',
    what: 'Igual que Deriv MT5, como fuente separada: cada servidor se guarda por su cuenta.',
    phase: 'Datos en Fase 1B; demo en Fase 4',
  },
];

export type PhaseState = 'hecha' | 'en curso' | 'prevista';

export interface RoadmapPhase {
  /** Identificador tal como aparece en el roadmap: «0», «1», «1B», «V1»… */
  readonly id: string;
  /** Título igual al del roadmap, sin paréntesis. */
  readonly title: string;
  readonly state: PhaseState;
  readonly text: string;
}

export const ROADMAP: readonly RoadmapPhase[] = [
  {
    id: '0',
    title: 'Fundación v2',
    state: 'hecha',
    text: 'Producto definido como bot de investigación, señales y ejecución controlada, con sus reglas de seguridad y riesgo.',
  },
  {
    id: 'V1',
    title: 'Línea visual V1',
    state: 'en curso',
    text: 'Marca, sistema de diseño, prototipo de la interfaz con datos ficticios y este sitio.',
  },
  {
    id: '1',
    title: 'Fundación de datos',
    state: 'en curso',
    text: 'Ya existen los contratos de datos, la normalización, las reglas de calidad y la publicación de datasets reproducibles. Falta conectar con Deriv y recuperar datos tras una desconexión.',
  },
  {
    id: '1B',
    title: 'Datos de MetaTrader 5',
    state: 'prevista',
    text: 'Precios de Deriv MT5 y Vantage con las mismas garantías, sin operar.',
  },
  {
    id: '2',
    title: 'Laboratorio y bot shadow para uso propio',
    state: 'prevista',
    text: 'Estrategias versionadas, backtests honestos y un bot que emite señales hipotéticas.',
  },
  {
    id: '3',
    title: 'Producto de señales web y móvil',
    state: 'prevista',
    text: 'Panel web y apps de Android e iOS para seguir señales con su evidencia.',
  },
  {
    id: '3B',
    title: 'Beta de suscriptores externos y señales pagas',
    state: 'prevista',
    text: 'Solo después de definir jurisdicción, términos y cumplimiento.',
  },
  {
    id: '4',
    title: 'Integración de ejecución demo',
    state: 'prevista',
    text: 'Órdenes con dinero de práctica, política de riesgo, auditoría e interruptor de emergencia.',
  },
  {
    id: '5',
    title: 'Evaluación para ejecución real',
    state: 'prevista',
    text: 'Una decisión con evidencia. Decir que no también es un resultado válido.',
  },
  {
    id: '6',
    title: 'Ejecución real controlada',
    state: 'prevista',
    text: 'Solo el universo, las cuentas y las estrategias aprobados, con límites conservadores.',
  },
  {
    id: '7',
    title: 'Clientes complementarios',
    state: 'prevista',
    text: 'Aplicación de Windows y, como opción, una capa de consulta pasiva en Android.',
  },
];

export interface Question {
  readonly q: string;
  readonly a: string;
}

export const FAQ: readonly Question[] = [
  {
    q: '¿Puedo usar buoh hoy?',
    a: 'Todavía no. buoh está en desarrollo y por ahora es de uso propio. No ofrece señales, cuentas ni ejecución.',
  },
  {
    q: '¿buoh gana dinero?',
    a: 'No lo sabemos, y nadie puede saberlo de antemano. buoh existe para medirlo con honestidad, incluidas las pérdidas.',
  },
  {
    q: '¿Me pedirán contraseñas?',
    a: 'Nunca la de tu cuenta Deriv ni contraseñas de terceros. La futura conexión con Deriv será por autorización delegada (OAuth). En MetaTrader 5 solo se usarán cuentas propias del dueño del proyecto; su contraseña la guardará solo la terminal y los servicios de buoh nunca la recibirán.',
  },
  {
    q: '¿buoh opera por mí?',
    a: 'Hoy no. Primero se usará solo con cuentas propias: en demo y, si se aprueba, en real, siempre a través de un servicio de servidor con límites de riesgo. Ofrecer ejecución a otras personas depende de una evaluación legal y de cumplimiento que todavía no se ha hecho.',
  },
];
