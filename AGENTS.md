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
9. Abre un PR pequeño usando la plantilla y fusiónalo con las condiciones de «Fusión».

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

El propietario decidió el 2026-10-26 que el agente fusione sus propios PR («siempre haces merge tú»). El agente fusiona sin esperarlo solo si se cumplen estas condiciones:

- la revisión semántica terminó sin hallazgos bloqueantes, y los commits posteriores a ella solo corrigen sus hallazgos; cualquier otro cambio va en un PR nuevo;
- CI está en verde sobre el último commit del PR, y la fusión se pide para ese commit;
- antes de fusionar, deja en el PR un comentario que dice que fusiona por esta decisión, qué condiciones se cumplieron, qué commit se revisó y cuál se fusiona. Si el PR esperó al propietario, el comentario dice también cuándo y con qué palabras dio su visto bueno o su decisión.

Tres casos esperan al propietario:

- si el PR marca en la plantilla «Seguridad, secretos o permisos» o «Riesgo, señales o ejecución», el agente le explica el cambio en palabras simples y fusiona solo con su visto bueno, porque la seguridad y el riesgo conservan revisión humana (`CONTRIBUTING.md`);
- si el PR necesita una decisión del propietario sobre producto, dinero, riesgo o seguridad, el agente la pide primero («Protocolo ante conflictos o vacíos») y fusiona solo después;
- si el PR crea una ADR que nombra al propietario entre sus decisores, o cambia una decisión de una ADR así, fusiona solo con su visto bueno. Las ADR cuyo único decisor es la dirección técnica siguen el flujo normal.

El propietario puede pedir cambios, revertir un PR fusionado o volver a fusionar él mismo cuando quiera. Nadie sube cambios directamente a `main`.

## Desarrollo por fases

Solo crea directorios y dependencias requeridos por un plan activo (`plan` o `parallel_plans` de `PROJECT_STATUS.md`). La arquitectura objetivo describe el destino, no autoriza implementar todo el destino en una fase temprana. La configuración del agente en `.kiro/` (steering e instalador de skills) no es un componente del producto y sigue ADR-0014.
