# Contribuir a buoh

## Propósito

buoh es un sistema de investigación, señales y futura ejecución controlada. Cada cambio debe aportar evidencia verificable; no se aceptan atajos que mezclen experimentación con ejecución.

## Antes de modificar

1. Sigue el orden de lectura de [`AGENTS.md`](AGENTS.md).
2. Confirma fase, estado y siguiente tarea en [`PROJECT_STATUS.md`](PROJECT_STATUS.md).
3. Relaciona el cambio con IDs del plan activo.
4. Lee código, contratos, ADR y runbooks afectados antes de proponer cambios.
5. Si altera datos, contratos, estrategia, riesgo, ejecución, seguridad, infraestructura o alcance, actualiza la fuente canónica o crea una ADR antes del código.

No agregues cuentas reales, secretos, pagos ni ejecución con dinero real sin una puerta aprobada.

## Fuentes de verdad

La autoridad está asignada por materia en `AGENTS.md`; `docs/` no es una única fuente intercambiable. En particular:

- el plan activo gobierna alcance y aceptación;
- las ADR aceptadas gobiernan decisiones duraderas;
- `packages/contracts`, cuando exista, gobierna forma ejecutable de datos;
- `PROJECT_STATUS.md` gobierna el estado actual;
- README resume y enlaza, pero no decide.

Ante un conflicto, no elijas una interpretación silenciosa: aplica el protocolo de `AGENTS.md`.

## Organización autorizada para Fase 1

La Fase 1 terminó el 2026-10-29. Su [plan](docs/plan/fase-1-fundacion-de-datos.md) autorizó estas piezas, que siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo, y el de la Fase 2 es la siguiente tarea de `PROJECT_STATUS.md`:

- `apps/market-data-worker/`: adaptación de fuente y orquestación de ingesta.
- `packages/contracts/`: esquemas runtime y JSON Schema generado.
- `packages/domain/`: normalización y reglas puras de datos de mercado.
- `infra/`: PostgreSQL estándar y almacenamiento S3-compatible local.
- `test-vectors/`: oráculos sintéticos compartidos.
- `docs/`: planes, decisiones, semántica y operación.

No crees componentes futuros o directorios vacíos fuera del [corte de Fase 1](docs/plan/fase-1-fundacion-de-datos.md) y del corte de la línea visual V1 (sección siguiente).

## Organización autorizada para la línea visual V1

La línea visual V1 corrió en paralelo a Fase 1 y terminó el 2026-10-25. Su [plan](docs/plan/linea-visual-v1.md) y [ADR-0008](docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md) autorizaron estas piezas, que siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo:

- `packages/design-system/`: tokens, CSS base y componentes React web; la guía es [`docs/diseno/marca-buoh.md`](docs/diseno/marca-buoh.md).
- `apps/web/`: prototipo navegable del producto con datos ficticios, sin API, cuentas ni brókeres.
- `apps/mobile/`: prototipo móvil (Expo) con datos ficticios ([ADR-0009](docs/arquitectura/adr/0009-prototipo-movil.md)).
- `apps/desktop/`: prototipo de escritorio (Tauri 2) que muestra `apps/web` en Windows ([ADR-0010](docs/arquitectura/adr/0010-prototipo-de-escritorio.md)). Su Rust se compila en el flujo `desktop` de CI.
- `packages/prototype-data/`: datos ficticios compartidos por los prototipos.
- `apps/site/`: sitio oficial estático, sin formularios ni recursos de terceros; sus reglas de contenido están en [`docs/diseno/sitio-oficial.md`](docs/diseno/sitio-oficial.md).
- `docs/diseno/`: marca y concepto de interfaz.

La guardia documental pide revisar la guía de marca al tocar `packages/design-system/**`, el concepto de interfaz o ADR-0008 al tocar `apps/web/**` o `packages/prototype-data/**`, el concepto de interfaz o ADR-0009 al tocar `apps/mobile/**`, el concepto de interfaz o ADR-0010 al tocar `apps/desktop/**` o su flujo de CI, y las reglas del sitio o ADR-0008 al tocar `apps/site/**`.

## Reglas de implementación

- TypeScript estricto es el lenguaje principal; Python queda fuera de la ruta inicial de ingesta.
- Valida toda entrada externa en runtime; los tipos estáticos no bastan.
- Usa UTC, UUIDv7 inyectable, esquemas versionados y SHA-256 según ADR-0004.
- Cotizaciones e importes usan representación decimal canónica, nunca punto flotante binario de dominio.
- Funciones de normalización, calidad y riesgo deben ser puras, deterministas y probadas.
- `deployment_environment`, `execution_mode`, `strategy_lifecycle` y `service_health` son ejes distintos.
- Los clientes no contienen secretos ni credenciales con capacidad directa de ejecución.
- Los datos reales de mercado y artefactos sensibles no entran en Git.

## Calidad y evidencia

El primer PR de código debe implementar la interfaz de comandos definida en el plan. Desde entonces, cada cambio ejecuta los comandos aplicables, incluyendo `pnpm run verify`.

- Las pruebas se derivan del requisito y de vectores independientes, no de la implementación terminada.
- No afirmes que algo fue verificado si no ejecutaste la comprobación.
- Un código de salida cero no demuestra por sí solo todos los criterios: registra evidencia por ID.
- Pruebas live de Deriv son opt-in y no sustituyen pruebas offline.
- No actualices snapshots o expected outputs para hacer pasar una prueba sin justificar el cambio de contrato.

## Documentación y estado

Revisa impacto documental en todo PR. Actualiza `PROJECT_STATUS.md` cuando cambien fase, objetivo, siguiente tarea, bloqueos, decisiones pendientes, componentes autorizados o evidencia de salida. No lo conviertas en un changelog.

La guardia documental de `F1-GOV-001` usa [`docs/impact-map.json`](docs/impact-map.json):

```text
pnpm run docs:check
DOCS_BASE_REF=origin/main pnpm run verify:pr
pnpm run docs:check -- --acknowledge=contracts:Razón explícita para incluir en el PR
```

GitHub Actions (`.github/workflows/verify.yml`) ejecuta `DOCS_BASE_REF=origin/main pnpm run verify:pr` en cada PR hacia `main` y en cada push a `main`, con el Node y pnpm fijados. Un segundo job ejecuta `pnpm run test:integration` contra los servicios de `infra/compose.yaml` con credenciales efímeras; localmente requiere esos servicios (ver el [runbook](docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13)). El flujo `.github/workflows/desktop.yml` corre en Windows solo cuando cambian `apps/desktop`, `apps/web`, sus paquetes o la configuración de pnpm, Node, TypeScript o turbo: pasa `cargo fmt`, `cargo clippy` y `cargo test` y compila el instalador del prototipo de escritorio. `pnpm run data:replay` corre `scripts/data-replay.mjs`, `pnpm run data:smoke`, `scripts/data-smoke.mjs`, y `pnpm run data:health`, `scripts/data-health.mjs`; la guardia pide revisar el runbook de ingesta al tocar cualquiera de los tres. `data:smoke` es opt-in: sin `--live` no abre conexiones, así que ni `verify` ni CI tocan la red. `data:health` solo lee, y su prueba de `scripts/` solo recorre el error de uso, sin servicios. `render.yaml` define cómo Render publica el sitio oficial: al tocarlo, o su prueba `scripts/render-blueprint.test.mjs`, la guardia pide revisar [despliegue en Render](docs/operacion/despliegue-en-render.md) o [ADR-0013](docs/arquitectura/adr/0013-publicacion-del-sitio-en-render.md). `.kiro/instalar-skills.mjs` instala las skills de terceros del agente de Kiro, fuera del repositorio: al tocarlo, la guardia pide revisar el [steering de skills](.kiro/steering/skills-de-kiro.md) o [ADR-0014](docs/arquitectura/adr/0014-skills-de-terceros-para-el-agente.md).

Sin base, revisa cambios staged, unstaged y no rastreados. `verify:pr` exige `DOCS_BASE_REF` y revisa todo el rango comprometido contra la rama objetivo; lo no comprometido no cuenta. Si una ruta activa una regla, debe cambiar una fuente indicada o recibir una justificación de al menos 20 caracteres; la salida exige copiar esa razón al PR. La justificación solo se puede dar en la línea de comandos (`--acknowledge`): `verify:pr` y CI no la pasan, así que en CI toda regla activada exige cambiar una de sus fuentes, también cuando el cambio es solo de comentarios. Es lo que pide `F1-GOV-001`: el propietario decidió el 2026-10-25 que CI siga sin aceptar justificaciones. La guardia nunca modifica documentación. La seguridad y el riesgo conservan revisión humana: un PR que los afecte espera el visto bueno del propietario antes de fusionarse ([AGENTS.md](AGENTS.md), «Fusión»). Las ADR cuyo único decisor es la dirección técnica siguen el flujo normal de fusión. Crear una ADR que nombre al propietario entre sus decisores, o cambiar una de sus decisiones, espera su visto bueno.

## Pull requests

Usa [la plantilla](.github/pull_request_template.md) y declara:

- fase e IDs atendidos;
- alcance y no-alcance;
- decisiones y supuestos;
- comandos realmente ejecutados y resultados;
- evidencia reproducible;
- impacto técnico/documental;
- riesgos, límites y siguiente relevo.

El agente fusiona sus PR con las condiciones de [AGENTS.md](AGENTS.md) («Fusión»). No subas directamente a `main`.

## Git y commits

Usa ramas cortas con prefijo `feat/`, `fix/`, `docs/`, `chore/`, `test/` o `refactor/`. Los commits siguen:

```text
type(scope): resumen imperativo
```

Ejemplo: `feat(contracts): validate market tick schema`.

No incluyas secretos, datos de clientes, tokens de Deriv, archivos Parquet reales ni resultados no anonimizados en Git.
