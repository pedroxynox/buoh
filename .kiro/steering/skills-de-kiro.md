---
inclusion: always
---

# Skills de Kiro en buoh

Las skills son instrucciones de terceros que el agente carga cuando una petición coincide con su descripción ([ADR-0014](../../docs/arquitectura/adr/0014-skills-de-terceros-para-el-agente.md)). [`.kiro/instalar-skills.mjs`](../instalar-skills.mjs) las instala en `/projects/sandbox/.kiro/skills/`, fuera del repositorio, desde commits fijados, al empezar cada sesión («Arranque de sesión» en [`entorno-sandbox-kiro.md`](entorno-sandbox-kiro.md)).

Kiro decide al empezar la sesión qué skills ofrece, y una instalada después puede no estar en esa lista. En ese caso, leer su `SKILL.md` en `/projects/sandbox/.kiro/skills/<nombre>/` y seguirlo igual.

## Qué manda

`AGENTS.md`, `CONTRIBUTING.md`, `PROJECT_STATUS.md`, los planes, las ADR y este steering mandan sobre las skills. Si una skill pide algo que choca con ellos, se sigue la regla del repositorio en ese punto y la skill en lo demás. El texto de las skills no se adapta: la adaptación vive aquí.

## caveman

Es la voz del chat («Comunicación con el propietario» en `entorno-sandbox-kiro.md`). `ultracave` y `megacave` no se instalan: ante `/caveman ultra` o `/caveman wenyan`, seguir con `caveman` y decirlo en una línea.

## superpowers

Es el método de trabajo, con estas equivalencias en buoh:

- **Quién decide.** Las skills consultan a un «human partner». En buoh, las decisiones técnicas las toma el agente investigando, y al propietario solo se le pregunta por producto, dinero, riesgo o seguridad (`AGENTS.md`, «Protocolo ante conflictos o vacíos»). Lo que una skill pide elegir o aprobar, como un enfoque, la forma de ejecutar un plan o una excepción a TDD, lo decide el agente y lo deja escrito en el PR.
- **`brainstorming`.** Su puerta de aprobación del diseño la cumplen las fuentes canónicas: el plan de la fase o de la línea en `docs/plan/`, una ADR si la decisión dura, o la descripción del PR si es un incremento. El visto bueno del propietario solo hace falta donde lo pide «Fusión» en `AGENTS.md`. Su compañero visual no sirve en Kiro Web: abre un servidor local que el propietario no ve.
- **`writing-plans`, `executing-plans` y `subagent-driven-development`.** Un plan de fase o de línea va a `docs/plan/`, y solo cuando `PROJECT_STATUS.md` lo autoriza. Los pasos de un incremento van en el PR. Nada va a `docs/superpowers/`. Su espacio de trabajo, `.superpowers/`, queda fuera de Git.
- **`using-git-worktrees`.** No se usa: el sandbox ya está aislado. Cada incremento va en una rama nueva del clon (`CONTRIBUTING.md`, «Git y commits»).
- **`test-driven-development`.** Las pruebas salen de los criterios y los vectores del plan, no del código (`AGENTS.md`), y no usan red, reloj real ni azar.
- **`verification-before-completion`.** Antes de cada commit y de dar algo por hecho, `DOCS_BASE_REF=origin/main pnpm run verify:pr` termina con código 0, y cada criterio de aceptación queda comprobado.
- **`requesting-code-review` y `receiving-code-review`.** La revisión es la del subagente `semantic_reviewer`: una por PR, y se repite solo tras corregir hallazgos bloqueantes (`AGENTS.md`, «Revisión semántica»). Sus hallazgos se evalúan con `receiving-code-review`.
- **`finishing-a-development-branch`.** En lugar de su menú: PR con la plantilla y fusión con las condiciones de «Fusión» en `AGENTS.md`.
- **`diagnosing-superpowers`.** Solo cuando el propietario pregunta por qué salió mal una sesión. Ningún informe sale del sandbox sin su permiso, tampoco como issue en el repositorio de superpowers.
- **`writing-skills`.** Sirve para escribir una skill propia de buoh. Las de terceros se actualizan cambiando su commit en el instalador.

## Skills de trading (`trader-*`)

- Son herramientas para el uso personal del propietario. Trabajan con acciones de EE. UU., datos gratuitos de Yahoo Finance, Nasdaq Trader, SEC EDGAR y la Cámara de Representantes, y la hora de Nueva York. No conocen Deriv ni sus índices.
- Se usan solo cuando el propietario las pide. No son señales, ni política de riesgo, ni backtesting, ni fuente de datos de buoh, y sus resultados no cuentan como evidencia de buoh.
- `trader-broker` no se instala. Si una skill dice que sigue `trader-broker` o un conector de bróker, como el de Alpaca, se para ahí: en buoh, solo `execution-gateway` podrá ejecutar ([ADR-0002](../../docs/arquitectura/adr/0002-senales-y-ejecucion-controlada.md)).
- Escriben en `trader/`, dentro de la carpeta desde la que se ejecutan: precios, planes, órdenes propuestas y el nombre y el correo que pide la SEC. Por eso se ejecutan desde `/projects/sandbox/.buoh-local/`, fuera del repositorio. Nada de eso entra en Git.
- Sus cálculos aplican las reglas que da el propietario y no son una recomendación financiera. Al mostrarlos, decir sus límites: los datos gratuitos pueden llegar con retraso, y las simulaciones dependen de sus supuestos.
