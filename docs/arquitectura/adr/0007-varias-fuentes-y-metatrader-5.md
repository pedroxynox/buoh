# ADR-0007: Varias fuentes y MetaTrader 5

- **Estado:** Aceptada
- **Fecha:** 2026-10-24
- **Ámbito:** reglas de diseño desde F1.4b; integración MT5 después de Fase 1
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Complementa:** [ADR-0002](0002-senales-y-ejecucion-controlada.md) (añade un bróker y una excepción a la decisión 6) y [ADR-0003](0003-lenguajes-y-limites.md) (añade MQL5 con un límite estricto). No cambia el alcance de Fase 1 ni [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md).

## Contexto

Hasta ahora Deriv es la única integración prevista. El propietario decidió el 2026-10-24 que buoh también trabajará con MetaTrader 5 (MT5):

- para estudiar precios y, más adelante, para que el bot opere en MT5;
- con dos brókeres: Deriv MT5 y Vantage;
- con la posibilidad de que funcione desde un PC ("puede ser para pc también"); esta ADR lo interpreta como que la terminal MT5 puede correr en un PC del propietario (§4);
- aceptando que se guarde una contraseña de cuenta MT5.

ADR-0002 pide revisarse cuando se añade otro bróker, y su decisión 6 prohíbe aceptar contraseñas. ADR-0003 no prevé MQL5, el lenguaje de los programas de MT5.

Hechos verificados el 2026-10-24:

- La terminal MT5 se conecta al servidor de un bróker con número de cuenta, contraseña y nombre de servidor. La contraseña maestra da todos los permisos. La de inversor permite ver la cuenta, analizar precios y usar programas propios, pero no operar ([MetaTrader 5](https://www.metatrader5.com/en/terminal/help/startworking/authorization)).
- La contraseña de Deriv MT5 es distinta de la contraseña principal de la cuenta Deriv ([Deriv](https://deriv.com/help-centre-question/how-do-i-activate-a-deriv-mt5-trading-account)).
- Deriv ofrece CFD en Deriv MT5 y deja las opciones en Deriv Trader, Deriv Bot y Deriv GO ([Deriv](https://traders-academy.deriv.com/trading-guides/cfds-vs-options-trading)).
- Vantage ofrece MT5 en escritorio, web y móvil, y cuentas demo ([Vantage](https://www.vantagemarkets.com/en-au/academy/mt4-mt5-cfd-trading-platforms-insights/), [plataformas](https://latam.vantagemarkets.com/pt/trading-platform/)).
- El paquete oficial de Python `MetaTrader5` 5.0.6231 (publicado el 2026-09-27) solo trae instaladores para Windows de 64 bits y habla con una terminal abierta ([PyPI](https://pypi.org/project/MetaTrader5/)).
- MT5 funciona en Linux mediante Wine, con un instalador oficial ([MetaTrader 5](https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux)).
- Los programas MQL5 pueden abrir conexiones TCP, también con TLS, o hacer peticiones HTTP, pero solo hacia direcciones que el usuario autoriza a mano en la terminal ([MQL5](https://www.mql5.com/en/docs/network)).
- Mientras un Expert Advisor procesa un tick, los ticks nuevos que llegan se ignoran ([MQL5](https://www.mql5.com/en/docs/runtime/event_fire)).
- Un tick de MT5 (`MqlTick`) trae `time` en segundos, `time_msc` en milisegundos, `bid`, `ask`, `last`, `volume`, `volume_real` y `flags`. Los precios son números de punto flotante ([MQL5](https://www.mql5.com/en/docs/constants/structures/mqltick)).
- MQL5 calcula la hora GMT y la hora estimada del servidor a partir del reloj del equipo donde corre la terminal ([TimeGMT](https://www.mql5.com/en/docs/dateandtime/timegmt), [TimeTradeServer](https://www.mql5.com/en/docs/dateandtime/timetradeserver)).
- La hora que muestra MT5 es la del servidor del bróker; cada bróker elige su desfase respecto de UTC y puede cambiarlo con el horario de verano (fuente secundaria: [PineConnector](https://www.pineconnector.com/blogs/pico-blog/broker-server-time-vs-utc-vs-tradingview)).

## Decisión

### 1. Varias fuentes, cada una por separado

buoh admite varias fuentes de datos. Cada fuente tiene su propio valor de `source`, adaptador, normalizador, perfil de calidad, catálogo y log raw-first. Los contratos actuales ya lo permiten: `source` es texto libre y el log, el registro operativo y sus tablas están separados por fuente.

- Cada servidor MT5 de cada bróker es una fuente distinta. Deriv MT5 y Vantage no se mezclan, y tampoco sus servidores demo y real. Los identificadores exactos se fijan en el incremento que los implementa.
- Un dataset sigue teniendo una sola fuente. Combinar fuentes sería un derivado posterior con su propia decisión.
- Un mismo nombre no prueba que sea el mismo instrumento. Por ejemplo, el Volatility 100 de las opciones de Deriv y el de Deriv MT5 se tratan como instrumentos distintos mientras una medición no demuestre lo contrario. Los nombres oficiales se conservan por fuente sin reinterpretarlos (`F1-CATALOG-001`).

### 2. Deriv sigue primero; F1.4b deja la puerta preparada

Fase 1 sigue siendo solo Deriv. Los datos de MT5 llegan en una Fase 1B posterior; operar en MT5, en Fase 4 y siguientes (§6). Desde F1.4b, el código propio de una fuente se elige por fuente en lugar de quedar fijo:

- la conexión y su transporte, incluidos sus límites;
- la lectura del mensaje (normalizador);
- el vocabulario del perfil, como `non_tick_msg_types`;
- el validador de esquemas de la fuente.

La elección se deriva de lo que el dataset ya publica (el perfil y las versiones del manifiesto), para que el replay la reproduzca sin configuración externa. Si una fuente futura necesita identificar su normalizador de otra forma, ese cambio de contrato se decide en su incremento (§7).

El log raw-first, la publicación y el registro operativo no dependen de la fuente y no se tocan para añadir MT5. Fase 1 no crea código, directorios ni dependencias de MT5.

### 3. Puente MT5 escrito en MQL5

MT5 se integra mediante un programa MQL5 propio (el puente) que corre dentro de una terminal MT5 conectada a la cuenta.

- El puente abre una conexión saliente y cifrada hacia buoh y envía mensajes JSON con un contrato versionado en `packages/contracts`. El worker en TypeScript guarda cada mensaje como frame raw, igual que los de Deriv. Para MT5, el raw es el JSON del puente, no los datos internos de la terminal.
- El puente convierte los precios de punto flotante a texto decimal con los `digits` del símbolo, así que los servicios TypeScript nunca los tratan como punto flotante. Esa conversión se prueba con vectores compartidos, como pide ADR-0003 para las fórmulas de producción.
- Cada tick lleva `time_msc`, el desfase del servidor y la lectura del reloj del equipo, porque MQL5 calcula la hora UTC a partir de ese reloj. Así la conversión a UTC queda comprobable en el raw.
- MQL5 se limita al puente. Envía ticks, catálogo y el estado de conexión del puente; no envía saldo, posiciones ni historial de la cuenta mientras solo capture datos. Desde Fase 4 (demo) puede ejecutar intenciones ya aprobadas por `execution-gateway`. No contiene estrategia, política de riesgo ni decisiones de operar.
- Mientras el puente solo capture datos, no incluye código de operaciones.

### 4. Dónde corre la terminal MT5

La terminal necesita Windows, o Linux con Wine, y debe estar encendida mientras se capturan datos u opera el bot. Render no la aloja.

- Puede correr en un PC dedicado del propietario o en un servidor Windows o Linux con Wine. La elección queda pendiente y se decide en el primer incremento de Fase 1B, antes de escribir el puente.
- Esté donde esté, ese equipo forma parte de la infraestructura de servidor de buoh y no es un cliente. Se usa solo para la terminal y el puente; por eso un PC debe dedicarse a esa tarea. El puente solo acepta órdenes de `execution-gateway`.
- El futuro cliente Windows de buoh (Tauri 2) no incluye la terminal, el puente ni permisos de ejecución.
- Operar con dinero real desde un PC exige aprobación explícita en la evaluación de Fase 5.

### 5. Contraseñas de MT5: excepción acotada a ADR-0002, decisión 6

MT5 no ofrece autorización delegada como OAuth: la terminal entra a la cuenta con su propia contraseña. El propietario acepta guardar una contraseña. Esta ADR lo acota así:

- Solo cuentas MT5 del propietario. Las contraseñas de terceros, como las de futuros suscriptores, siguen prohibidas hasta una nueva ADR.
- La contraseña principal de la cuenta Deriv nunca se usa. Deriv MT5 tiene la suya.
- Para capturar datos se usa la contraseña de inversor, que no permite operar.
- La contraseña maestra, que sí permite operar, solo se usa desde Fase 4 (demo) y solo en cuentas demo, hasta que Fase 5 apruebe una cuenta real concreta.
- La contraseña la guarda solo la terminal MT5, en el equipo de la terminal. Los servicios de buoh nunca la reciben: no pasa por Git, PostgreSQL, almacenamiento de objetos, API, web, móvil, registros ni variables de entorno de otros servicios.
- El puente se identifica ante buoh con una credencial propia de buoh, revocable y distinta de la contraseña MT5.
- Para revocar el acceso, el propietario cambia la contraseña en el bróker y buoh revoca la credencial del puente.

### 6. Operar en MT5

Que el bot opere en MT5 es un objetivo aceptado y sigue ADR-0002 sin atajos: `shadow` → `demo` → `real`, y solo `execution-gateway` decide.

- El puente ejecuta únicamente intenciones aprobadas, con clave de idempotencia y reconciliación contra las posiciones y el historial de MT5.
- MT5 opera CFD con apalancamiento, y su pérdida no queda fijada al abrir como en una opción. Antes de operar en demo, `risk-policy` debe modelar posiciones CFD: tamaño, stop, margen, apalancamiento, spread y swap.
- Operar en demo con MT5 requiere su propia ADR al empezar Fase 4. Esa ADR debe resolver qué sustituye a los controles de autorización que hoy suponen OAuth (ADR-0002 decisión 4 y la puerta demo de seguridad §9), y que la cuenta del bot no se opere por otras vías.

### 7. Contratos

Los contratos no cambian ahora. Al integrar MT5 harán falta:

- precio de compra y de venta, último precio, volumen y `flags`;
- tiempo en milisegundos y su conversión a UTC;
- precisión por `digits`;
- catálogo por servidor;
- recuperación de historia de ticks y detección de huecos, porque la terminal descarta ticks mientras el puente procesa otro y Fase 1B debe cumplir `F1-RECONNECT-001` como Deriv.

Eso será una nueva versión de contrato o un tipo nuevo, decidido con datos reales en el incremento MT5. `MarketTick` 1.0.0 y los vectores de `test-vectors/` no se modifican.

### 8. Términos y cumplimiento

Antes de capturar datos u operar se revisan las condiciones de Deriv MT5, Vantage y MetaQuotes sobre programas automáticos y uso de datos. La redistribución de datos sigue deshabilitada, como en ADR-0004 §13. La evaluación legal y de cumplimiento previa al dinero real también cubre MT5 y la entidad de Vantage que corresponda.

## Consecuencias

- MT5 entra como fuente adicional sin rehacer el log, la publicación ni el replay.
- F1.4b cuesta algo más de diseño, porque separa lo que es de Deriv de lo común.
- Se añade un lenguaje (MQL5) y un equipo que hay que mantener encendido, actualizado y vigilado.
- Las contraseñas de MT5 quedan fuera de los servicios de buoh, pero el equipo de la terminal pasa a ser un activo sensible.
- La política de riesgo debe cubrir dos tipos de producto: opciones de Deriv y CFD de MT5.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Paquete Python `MetaTrader5` en la ruta de ingesta | Pone Python en la ruta crítica, contra ADR-0003, y solo funciona en Windows junto a la terminal. |
| Servicios en la nube de terceros que hacen de puente | Entregan la contraseña de la cuenta a un tercero y añaden un proveedor sin revisión. |
| API de servidor o Manager de MT5 | MetaQuotes la ofrece a brókeres para sus propias integraciones ([MetaQuotes](https://www.metaquotes.net/en/metatrader5/brokers)). |
| Guardar la contraseña en buoh (base de datos o variables) | Amplía la exposición sin necesidad: la terminal ya la guarda. |
| Integrar MT5 dentro de Fase 1 | Duplica el trabajo antes de cerrar la puerta de calidad de Deriv. |
| Mezclar Deriv MT5 y Vantage en una misma fuente | Son servidores, horarios y precios distintos; mezclarlos rompe la procedencia. |

## Pendientes

Antes de escribir el puente (primer incremento de Fase 1B):

- Equipo de la terminal MT5: PC dedicado del propietario o servidor Windows o Linux con Wine.
- Protección de ese equipo (cuenta del sistema, cifrado de disco, acceso remoto y actualizaciones) y dónde guarda el puente su credencial de buoh.
- Revisión de términos de Deriv MT5, Vantage y MetaQuotes (§8), y entidad y jurisdicción de Vantage que aplican al propietario.

Durante Fase 1B:

- Identificadores de fuente por bróker y servidor.
- Contrato de los mensajes del puente y su protocolo de conexión.
- Medición del desfase horario de cada servidor.

En la ADR de ejecución MT5 (Fase 4):

- Sustituto de los controles de autorización basados en OAuth.
- Exclusividad de las cuentas del bot y trato de posiciones que buoh no abrió.

Esta ADR no fija el orden entre Fase 1B y Fase 2; lo decide el propietario al cerrar Fase 1.

## Condiciones de revisión

Revisar esta ADR si MT5 o un bróker ofrece autorización delegada, si se añaden brókeres o cuentas de terceros, si cambia el equipo de la terminal o si la evidencia muestra que el puente no puede cumplir la conversión a UTC o la reconciliación.

## Referencias verificadas

- [MetaTrader 5: conexión a una cuenta (maestra e inversor)](https://www.metatrader5.com/en/terminal/help/startworking/authorization)
- [MetaTrader 5: instalación en Linux](https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux)
- [MQL5: funciones de red](https://www.mql5.com/en/docs/network)
- [MQL5: eventos de la terminal (NewTick)](https://www.mql5.com/en/docs/runtime/event_fire)
- [MQL5: estructura `MqlTick`](https://www.mql5.com/en/docs/constants/structures/mqltick)
- [MQL5: `TimeGMT`](https://www.mql5.com/en/docs/dateandtime/timegmt) y [`TimeTradeServer`](https://www.mql5.com/en/docs/dateandtime/timetradeserver)
- [MQL5: `initialize` del paquete Python](https://www.mql5.com/en/docs/python_metatrader5/mt5initialize_py)
- [PyPI: MetaTrader5](https://pypi.org/project/MetaTrader5/)
- [Deriv: contraseña de Deriv MT5](https://deriv.com/help-centre-question/how-do-i-activate-a-deriv-mt5-trading-account)
- [Deriv: CFD y opciones por plataforma](https://traders-academy.deriv.com/trading-guides/cfds-vs-options-trading)
- [Vantage: MT4 y MT5](https://www.vantagemarkets.com/en-au/academy/mt4-mt5-cfd-trading-platforms-insights/)
- [MetaQuotes: MetaTrader 5 para brókeres](https://www.metaquotes.net/en/metatrader5/brokers)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
