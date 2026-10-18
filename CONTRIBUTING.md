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

- `apps/market-data-worker/`: adaptación de fuente y orquestación de ingesta.
- `packages/contracts/`: esquemas runtime y JSON Schema generado.
- `packages/domain/`: normalización y reglas puras de datos de mercado.
- `infra/`: PostgreSQL estándar y almacenamiento S3-compatible local.
- `test-vectors/`: oráculos sintéticos compartidos.
- `docs/`: planes, decisiones, semántica y operación.

No crees componentes futuros o directorios vacíos fuera del [corte de Fase 1](docs/plan/fase-1-fundacion-de-datos.md).

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

Sin base, revisa cambios staged, unstaged y no rastreados. `verify:pr` exige `DOCS_BASE_REF` y revisa todo el rango comprometido contra la rama objetivo. Si una ruta activa una regla, debe cambiar una fuente indicada o recibir una justificación de al menos 20 caracteres; la salida exige copiar esa razón al PR. La guardia nunca modifica documentación. ADR, seguridad y riesgo conservan revisión humana.

## Pull requests

Usa [la plantilla](.github/pull_request_template.md) y declara:

- fase e IDs atendidos;
- alcance y no-alcance;
- decisiones y supuestos;
- comandos realmente ejecutados y resultados;
- evidencia reproducible;
- impacto técnico/documental;
- riesgos, límites y siguiente relevo.

El usuario conserva la decisión de solicitar cambios o fusionar. No subas directamente a `main`.

## Git y commits

Usa ramas cortas con prefijo `feat/`, `fix/`, `docs/`, `chore/`, `test/` o `refactor/`. Los commits siguen:

```text
type(scope): resumen imperativo
```

Ejemplo: `feat(contracts): validate market tick schema`.

No incluyas secretos, datos de clientes, tokens de Deriv, archivos Parquet reales ni resultados no anonimizados en Git.
