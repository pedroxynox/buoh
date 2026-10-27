# ADR-0014: Skills de terceros para el agente de Kiro

- **Estado:** Aceptada
- **Fecha:** 2026-10-27
- **Ámbito:** skills de terceros del agente de Kiro: `.kiro/instalar-skills.mjs`, `.kiro/steering/skills-de-kiro.md` y el «Arranque de sesión» de `.kiro/steering/entorno-sandbox-kiro.md`. No cambia el producto.
- **Decisores:** Propietario de buoh (instalar caveman, superpowers y day-trader-skill, y hablar con caveman en todas las sesiones), con la dirección técnica (cómo se instalan y cómo se aplican en buoh).

## Contexto

El 2026-10-27 el propietario pidió instalar dos colecciones de skills y que el agente le explicara cómo usarlas en el proyecto: «Trabaja sobre la skill day-trader-skill y superpowers tambinen, estas las debes instalar y me dices como puedo usarlas durante el proyecto». La sesión anterior ya le hablaba con la skill caveman. El agente le propuso guardar en el repositorio una regla para que todas las sesiones usen caveman y apliquen estas skills, sin que él tenga que pegar un texto al empezar. Respondió «Si hazlo».

Una skill es una carpeta con un `SKILL.md`: instrucciones que el agente carga cuando una petición coincide con su descripción, a veces con scripts de apoyo. Hechos comprobados el 2026-10-27:

- **Qué carga Kiro Web, según su documentación.** La configuración del proyecto que está en el `.kiro/` del repositorio llega con el clon y se aplica sola. Kiro también busca `AGENTS.md` en las subcarpetas del espacio de trabajo. El steering personal que el propietario guarda en su cuenta (Agent Config → Steering) vale para todas sus sesiones en la nube. Kiro Web no ejecuta hooks.
- **Qué cargó en la sesión del 2026-10-27.** La raíz del espacio de trabajo era `/projects/sandbox`, y el repositorio estaba en `/projects/sandbox/buoh`. El agente no recibió ni el steering ni el `AGENTS.md` del repositorio, y la configuración personal del propietario llegó vacía. Al empezar, Kiro ofrecía caveman y las 15 skills de superpowers, que no venían de ninguna carpeta del sandbox: no estaban en `/projects`, `/root`, `/home`, `/opt`, `/usr/local` ni `/etc`. Kiro fija esa lista al empezar la sesión. Después se copiaron skills a `/projects/sandbox/.kiro/skills/`. caveman se cargó desde esa copia, pero `trader-risk`, copiada a la misma carpeta, no se pudo activar por su nombre. Su `SKILL.md` sí se puede leer como un archivo.
- **El sandbox.** Cada sesión empieza con un sandbox nuevo, sin lo que dejó la anterior, y con acceso a internet.
- **caveman** ([JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman), Apache-2.0). La skill `caveman` cambia solo la forma de escribir en el chat: la respuesta va primero, sin relleno, y todo dato técnico queda literal. La propia skill vuelve a la prosa normal en los avisos de seguridad, en las preguntas y en todo lo que queda fuera del chat, como código, commits, PR o documentos.
- **superpowers** ([obra/superpowers](https://github.com/obra/superpowers), MIT). 15 skills de método de trabajo: diseño previo, planes, desarrollo guiado por pruebas, depuración sistemática, revisión y verificación antes de dar algo por terminado. Están escritas para un «human partner» que aprueba diseños y elige opciones, y guardan diseños y planes en `docs/superpowers/`.
- **day-trader-skill** ([Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill), MIT). 11 skills para operar acciones de EE. UU. dentro del día:
  - Usan datos gratuitos de Yahoo Finance, Stooq, Nasdaq Trader, SEC EDGAR y la Cámara de Representantes, con la hora de Nueva York. Ninguna conoce Deriv ni sus índices.
  - Escriben sus archivos en `trader/`, dentro de la carpeta desde la que se ejecutan. Las herramientas de la SEC piden el nombre y el correo de quien las usa.
  - Su texto y sus ejemplos traen datos reales de mercado: precios de TSLA del 2026-10-19, cifras publicadas por Apple y los cinco mayores pesos de la cartera 13F de Berkshire Hathaway.
  - `trader-broker` envía órdenes a Alpaca. Las otras diez no envían órdenes.

## Decisión

### 1. Qué se instala

- De caveman, solo la skill `caveman`.
- De superpowers, sus 15 skills.
- De day-trader-skill, 10 de sus 11: todas menos `trader-broker` (§5).

### 2. Cómo se instala

`.kiro/instalar-skills.mjs` descarga cada origen en un commit fijado y copia esas skills a `/projects/sandbox/.kiro/skills/`, la carpeta donde Kiro Web las encuentra. Cada skill va con la licencia de su proyecto. Git comprueba que lo descargado corresponde al hash del commit.

Las descargas y las copias quedan fuera del repositorio. El instalador se niega a escribir dentro de él, también a través de enlaces simbólicos, y `.gitignore` excluye `/.kiro/skills/` por si alguien las copia allí. Ninguna skill de terceros entra en Git:

- las de trading no pueden, porque traen datos reales de mercado (`AGENTS.md`, «Invariantes no negociables»);
- con las demás, buoh hace lo mismo que con sus dependencias: fija la versión y no guarda una copia (ADR-0003, «Baseline de toolchain»).

El instalador es la fuente canónica de los commits. Actualizar uno es un PR propio:

- comprueba que el commit nuevo está en la rama principal del origen, porque GitHub también entrega por la URL del origen un commit que solo existe en un fork;
- revisa el diff del origen entre ambos commits como el de una dependencia.

Si se toca el instalador, la guardia documental pide revisar el steering de skills o esta ADR.

### 3. Arranque de sesión

Antes de su primera respuesta, el agente ejecuta el instalador y sigue el resto del «Arranque de sesión» de [`.kiro/steering/entorno-sandbox-kiro.md`](../../../.kiro/steering/entorno-sandbox-kiro.md). Lo pone en marcha un texto corto que el propietario guarda una vez en su steering personal. Ese texto está en el mismo archivo, y según la documentación es la configuración que llega a todas sus sesiones, esté donde esté el repositorio. Si una sesión empieza sin seguir el arranque, basta con pedirlo en el primer mensaje.

Kiro decide al empezar la sesión qué skills ofrece. Si una skill instalada no está en esa lista, el agente lee su `SKILL.md` y lo sigue igual.

### 4. Las reglas del repositorio mandan

`AGENTS.md`, `CONTRIBUTING.md`, `PROJECT_STATUS.md`, los planes, las ADR y el steering mandan sobre las skills, y la propia `using-superpowers` lo admite. [`.kiro/steering/skills-de-kiro.md`](../../../.kiro/steering/skills-de-kiro.md) dice cómo se aplica cada skill en buoh. En resumen:

- las decisiones técnicas las toma el agente, y al propietario solo se le pregunta por producto, dinero, riesgo o seguridad;
- los diseños y planes van a `docs/plan/`, a una ADR o al PR, nunca a `docs/superpowers/`;
- la revisión es la semántica de cada PR, y el cierre de una rama sigue «Fusión» de `AGENTS.md`.

El texto de las skills no se adapta: la adaptación a buoh vive en el steering.

### 5. Las skills de trading quedan fuera del producto

- Las skills `trader-*` son herramientas para el uso personal del propietario, y se usan solo cuando él las pide.
- No son señales, ni política de riesgo, ni backtesting, ni fuente de datos de buoh. Sus resultados no cuentan como evidencia de buoh.
- `trader-broker` no se instala, y el instalador la borra si una sesión anterior la dejó. Tampoco se instala ningún conector a un bróker: en buoh, solo `execution-gateway` podrá ejecutar ([ADR-0002](0002-senales-y-ejecucion-controlada.md)).
- Se ejecutan fuera del repositorio. Sus archivos no entran en Git: precios, planes, órdenes propuestas y el nombre y el correo que pide la SEC. `.gitignore` excluye `/trader/` por si alguna se ejecuta en la raíz del repositorio, y también `/.superpowers/`, el espacio de trabajo temporal de algunas skills de superpowers.
- Lo que calculan aplica las reglas que da el propietario. No es una recomendación financiera.

### 6. Qué no autoriza

- Componentes del producto o adelantos de fase: la configuración del agente no es un componente (`AGENTS.md`, «Desarrollo por fases»).
- Ejecutar el instalador o los scripts de las skills en CI o desde código de buoh.
- Sacar del sandbox un informe de sesión de `diagnosing-superpowers` sin permiso del propietario, por ejemplo como issue en el repositorio de superpowers: puede llevar datos privados.

## Consecuencias

- El agente sigue instrucciones escritas por terceros, y tiene permiso para escribir en el repositorio. Una instrucción de una skill que choque con las reglas de buoh no se sigue (§4).
- Las skills solo cambian si cambia un commit del instalador, y en `main` eso solo entra con un PR. Una sesión abierta en otra rama ejecuta el instalador de esa rama: por eso el arranque avisa al propietario si difiere del de `main`.
- Cada sesión necesita internet para instalarlas. Si falta un origen, o desaparece su commit, el instalador avisa y deja instalados los demás. Las skills que Kiro ya ofrecía al empezar, como caveman y superpowers el 2026-10-27, siguen disponibles en la versión que Kiro tenga.
- El propietario guarda una vez un texto corto en su configuración de Kiro. Sin él, o si Kiro no lo carga, cada sesión necesita un primer mensaje que pida seguir el arranque.
- El propietario solo puede llamar con `/` a las skills que Kiro ofrece al empezar la sesión. Las de trading las pide con palabras.
- Kiro elige una skill por su descripción, así que las de trading podrían ofrecerse ante una frase como «revisa mi orden». El steering limita su uso a cuando el propietario las pide.
- Cada sesión carga el steering de skills y, cuando hace falta, el texto de cada skill, así que gasta algo más de contexto.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Copiar las skills al repositorio | Las de trading traen datos reales de mercado, que no entran en Git. Copiar solo las demás metería unas 11 000 líneas de instrucciones y scripts de terceros que buoh no mantiene, y el commit fijado ya da su texto exacto. |
| Usar solo las skills que Kiro ya ofrece | No se sabe de dónde vienen ni qué versión son, y faltan las de trading. |
| Subirlas a la configuración personal de Kiro del propietario | Le pide descargar y subir 26 carpetas, y quedan fuera de la revisión de los PR. |
| Instalar las 11 skills de trading | `trader-broker` envía órdenes a un bróker desde el chat, contra ADR-0002 y `AGENTS.md`. |
| Instalar todas las skills de caveman | Solo hace falta la voz del chat. Las demás comprimen archivos, escriben commits y revisiones o guardan memoria, y cambiarían el proceso del repositorio. |
| Un hook al empezar la sesión | Kiro Web no ejecuta hooks. |

## Referencias verificadas

- [Kiro: skills](https://kiro.dev/docs/skills.md) y [steering](https://kiro.dev/docs/steering.md)
- [Kiro: sesiones en la nube](https://kiro.dev/docs/cloud-sessions.md) y [sincronización de la configuración](https://kiro.dev/docs/web/cloud-configuration.md)
- [Kiro: hooks](https://kiro.dev/docs/hooks.md)
- Los repositorios de origen, en los commits fijados en `.kiro/instalar-skills.mjs`

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
