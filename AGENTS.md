# Contrato de trabajo para agentes de IA

Este archivo es el punto de entrada neutral para cualquier motor de IA que trabaje en buoh. No sustituye los documentos especializados: indica cuál gobierna cada decisión y cómo ejecutar cambios sin inventar contexto.

## Lectura obligatoria

Antes de proponer o modificar archivos, lee en este orden:

1. [`AGENTS.md`](AGENTS.md): proceso y jerarquía de autoridad.
2. [`PROJECT_STATUS.md`](PROJECT_STATUS.md): estado vigente, objetivo y siguiente tarea.
3. Los planes activos enlazados desde `PROJECT_STATUS.md`: el de la fase (`plan`) y los que corren en paralelo (`parallel_plans`).
4. Los contratos, ADR y runbooks afectados por la tarea.
5. El código y las pruebas relacionados, cuando existan.

No uses conversaciones anteriores como fuente de verdad si contradicen el repositorio.

## Autoridad por materia

| Materia | Fuente canónica |
|---|---|
| Estado y siguiente trabajo | `PROJECT_STATUS.md` |
| Alcance y aceptación de una fase | `docs/plan/` |
| Decisiones técnicas duraderas | ADR aceptadas en `docs/arquitectura/adr/`; una ADR posterior puede sustituir otra explícitamente |
| Forma exacta de datos y eventos | Esquemas ejecutables en `packages/contracts` cuando existan; antes, `docs/arquitectura/contratos-de-dominio.md` |
| Semántica del dominio | `docs/arquitectura/contratos-de-dominio.md` y documentos de gobierno |
| Operación e incidentes | `docs/operacion/` |
| Contribución y revisión | `CONTRIBUTING.md` y `.github/pull_request_template.md` |
| Visión y modelo comercial | `docs/producto/` |
| Resumen de navegación | `README.md`; nunca prevalece sobre una fuente especializada |

`.kiro/steering/` es un adaptador de contexto para Kiro y debe apuntar a estas fuentes, no convertirse en una especificación paralela. Las skills de terceros que usa el agente ceden ante estas fuentes ([ADR-0014](docs/arquitectura/adr/0014-skills-de-terceros-para-el-agente.md)).

## Protocolo ante conflictos o vacíos

1. No elijas silenciosamente una interpretación.
2. Identifica las fuentes y el punto exacto de conflicto.
3. Si la decisión es reversible y está dentro del plan, registra el supuesto en el PR.
4. Si afecta contratos, datos, seguridad, riesgo, ejecución, plataforma o alcance, actualiza la fuente canónica o crea una ADR antes del código.
5. Si falta una decisión humana que cambia riesgo o producto, detén solo la parte bloqueada y solicita la decisión.

Está prohibido inventar requisitos, resultados de pruebas, comandos ejecutados, credenciales, datos de mercado o decisiones de negocio.

## Invariantes no negociables

- Separar investigación, señales y ejecución.
- Ningún cliente ni estrategia se comunica directamente con el bróker para ejecutar; la futura ejecución pasa por `execution-gateway` y su política de riesgo.
- `execution_mode` (`disabled | shadow | demo | real`) no es `service_health` ni `strategy_lifecycle`.
- Conservar datos crudos inmutables, procedencia, tiempo de fuente, tiempo de recepción, esquema y calidad.
- Usar UTC, decimales canónicos y validación runtime en límites externos.
- No incluir secretos, contraseñas, tokens, datos personales, datos reales de mercado ni resultados sensibles en Git.
- No prometer rentabilidad ni ocultar resultados negativos o limitaciones.
- No habilitar dinero real sin las puertas cuantitativas, técnicas, operativas y de cumplimiento aprobadas.

Los detalles completos están en [fundamentos de buoh](.kiro/steering/fundamentos-buoh.md), [seguridad y rigor](docs/gobierno/seguridad-y-rigor-cuantitativo.md) y [operación y riesgo](docs/gobierno/operacion-y-control-de-riesgo.md).

## Protocolo de ejecución de tareas

1. Relaciona la tarea con IDs del plan activo.
2. Declara alcance, no-alcance, supuestos y archivos esperados.
3. Inspecciona antes de editar; no propongas cambios sobre código no leído.
4. Implementa el incremento mínimo completo. No generes componentes futuros como marcadores vacíos.
5. Deriva pruebas de los criterios y vectores acordados, no de la implementación resultante.
6. Ejecuta las verificaciones disponibles y conserva comandos y resultados exactos.
7. Revisa impacto documental y actualiza la fuente canónica correspondiente.
8. Actualiza `PROJECT_STATUS.md` solo si cambian fase, objetivo, tarea siguiente, bloqueo, decisión pendiente o evidencia de salida.
9. Abre un PR pequeño usando la plantilla y déjalo listo para que el propietario lo fusione («Fusión»).

No se considera terminado un cambio porque compile o porque un comando termine con código cero: verifica cada criterio de aceptación aplicable.

## Relevo entre modelos

El PR es el paquete de relevo. Debe permitir que otro modelo revise el cambio sin acceder a la conversación del autor e incluir:

- IDs de requisitos atendidos;
- decisiones y supuestos;
- archivos y contratos afectados;
- comandos realmente ejecutados y resultados;
- evidencia reproducible;
- riesgos, límites y trabajo pendiente.

El modelo revisor contrasta el diff con fuentes canónicas y vectores independientes; no acepta como prueba la explicación del modelo autor.

### Revisión semántica

- Cada PR recibe una sola revisión semántica.
- Solo se repite si encontró hallazgos bloqueantes, y únicamente tras corregirlos.
- Los hallazgos menores no reabren la revisión: quedan anotados en el PR como pendientes.

### Fusión

El propietario decidió el 2026-10-29 fusionar él mismo todos los PR («siempre yo haré merge y tu abres los pr normalmente»). Esta decisión sustituye a la del 2026-10-26, por la que el agente fusionaba sus propios PR. El agente no fusiona ningún PR.

El agente deja cada PR listo para fusionar:

- la revisión semántica terminó sin hallazgos bloqueantes, y los commits posteriores a ella solo corrigen sus hallazgos; cualquier otro cambio va en un PR nuevo;
- CI está en verde sobre el último commit del PR;
- deja en el PR un comentario que dice que está listo, qué commit revisó la revisión semántica y en qué commit está CI en verde;
- da al propietario el enlace y le explica en palabras simples qué cambia el PR.

Si después de ese comentario entra otro commit, por ejemplo para actualizar la rama con `main`, el PR deja de estar listo hasta un comentario nuevo con CI en verde sobre ese commit. Actualizar con `main` sin otros cambios no reabre la revisión semántica; si hubo que resolver un conflicto, el comentario nuevo dice cómo.

La fusión del propietario es su visto bueno. Por eso, al darle el enlace, el agente le dice también:

- si el PR marca en la plantilla «Seguridad, secretos o permisos» o «Riesgo, señales o ejecución», qué cambia en la seguridad o el riesgo, que conservan revisión humana (`CONTRIBUTING.md`);
- si el PR crea una ADR que lo nombra entre sus decisores, o cambia una decisión de una ADR así, que fusionarlo aprueba esa decisión.

Si el PR necesita una decisión del propietario sobre producto, dinero, riesgo o seguridad, el agente le explica las opciones y su recomendación y le pide la decisión antes de abrir el PR («Protocolo ante conflictos o vacíos»). El PR registra cuándo y con qué palabras la dio.

Cada PR sale de `main` actualizado. Si el trabajo siguiente necesita un PR que el propietario todavía no fusionó, el agente se lo dice y, mientras tanto, avanza en lo que no dependa de él.

El propietario puede pedir cambios, cerrar un PR sin fusionarlo o revertir uno fusionado cuando quiera. Nadie sube cambios directamente a `main`.

## Eficiencia

El propietario decidió el 2026-10-30 que el agente mantenga todas las reglas de este archivo y deje los extras que añadía por su cuenta («si la b y dejalo documentado para que otras sesiones lo interpreten bien, ojo, sin perder eficacia en el proyecto»). Cada comprobación cuesta tiempo y crédito, así que se hace cuando puede encontrar un error que las demás no encuentran.

No cambian:

- la revisión semántica de cada PR, las verificaciones del paso 6 de «Protocolo de ejecución de tareas», CI en verde y el comentario de listo («Fusión»);
- las pruebas que salen de los criterios del plan, de las ADR y de los vectores, con sus casos de fallo;
- la documentación que pide la guardia documental.

Se hacen solo cuando el cambio las necesita:

- **Mutaciones a propósito**, para ver si las pruebas detectan un cambio de una línea: en código que decide los contratos, qué datos se escriben, se leen o se publican, el riesgo, las señales, la ejecución o la seguridad, como el de un PR que marca alguna de las cuatro primeras casillas de «Impacto» de la plantilla, y solo en las líneas que deciden su comportamiento.
- **Mediciones** de tiempo o de memoria: cuando un criterio, un plazo de prueba o una decisión dependen de ellas.
- **Las pruebas de integración en local**: cuando el cambio toca PostgreSQL, el almacenamiento de objetos o una migración. CI las corre siempre.
- **Una investigación con un subagente**: en un área que el agente no conoce. Su resultado se reutiliza y no se repite.
- **Repetir una verificación**: cuando algo cambió desde la última. Tras un rebase que deja el mismo árbol que el commit verificado (`git diff --quiet <commit verificado> HEAD` sale con 0), las pruebas de entonces valen; la guardia documental se vuelve a ejecutar, porque compara con la base nueva (`DOCS_BASE_REF=origin/main node scripts/check-doc-impact.mjs --require-base`), y el PR lo dice. Un rebase que cambia el árbol, como el que trae commits nuevos de `main`, se verifica entero.

Se escriben cortos:

- la descripción del PR: la plantilla, con lo que otro modelo necesita para revisar sin la conversación («Relevo entre modelos»);
- el encargo al revisor: contrastar el diff con las fuentes canónicas y con los vectores independientes («Relevo entre modelos») y buscar errores. Repite pruebas, mide o prueba sondas cuando sospecha uno.

Si ahorrar choca con la corrección, gana la corrección, y el PR dice por qué hizo falta lo que no es habitual.

## Desarrollo por fases

Solo crea directorios y dependencias requeridos por un plan activo (`plan` o `parallel_plans` de `PROJECT_STATUS.md`). La arquitectura objetivo describe el destino, no autoriza implementar todo el destino en una fase temprana. El instalador de skills del agente (`.kiro/instalar-skills.mjs`) y su steering no son componentes del producto y siguen ADR-0014.
