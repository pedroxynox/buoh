---
inclusion: always
---

# Trabajo en el sandbox de Kiro Web

Notas prácticas para sesiones de Kiro. No deciden nada: el proceso está en [`AGENTS.md`](../../AGENTS.md) y [`CONTRIBUTING.md`](../../CONTRIBUTING.md), el estado y la siguiente tarea en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y el entorno local canónico en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

## Arranque de sesión

Kiro Web abre el espacio de trabajo en `/projects/sandbox`, con el repositorio en `/projects/sandbox/buoh`. El 2026-10-27 el agente no recibió ni este steering ni el `AGENTS.md` del repositorio ([ADR-0014](../../docs/arquitectura/adr/0014-skills-de-terceros-para-el-agente.md), «Contexto»). Antes de la primera respuesta de cada sesión:

1. Instalar las skills: `node /projects/sandbox/buoh/.kiro/instalar-skills.mjs`. Si termina con 1, decir al propietario en una línea qué origen faltó y seguir con las demás. Si el instalador de la rama de la sesión no es el de `main` (`git -C /projects/sandbox/buoh diff --quiet origin/main -- .kiro/instalar-skills.mjs` falla), no ejecutarlo sin preguntar antes al propietario: puede traer skills que nadie ha revisado (ADR-0014, «Consecuencias»).
2. Activar la skill `caveman` («Comunicación con el propietario»).
3. Leer, en orden: `AGENTS.md`, `PROJECT_STATUS.md`, `.kiro/steering/fundamentos-buoh.md`, este archivo, [`skills-de-kiro.md`](skills-de-kiro.md), el plan activo y lo que toque la tarea.
4. Comprobar el estado real: `git fetch`, la rama actual y `gh api "repos/pedroxynox/buoh/pulls?state=all&per_page=5"`. Cada incremento empieza en una rama nueva desde `main` actualizado; una rama ya fusionada no se reutiliza. Si un PR listo sigue abierto (`gh api "repos/pedroxynox/buoh/pulls?state=open"`), recordarle al propietario en una línea que espera su fusión.
5. Poner título y descripción a la sesión de Kiro.

El contexto que dura vive en `AGENTS.md`, `PROJECT_STATUS.md` y `.kiro/steering/`. No crear otros archivos de contexto o memoria en el repositorio, como `.claude/napkin.md`.

Estos pasos los pone en marcha el steering personal del propietario: en app.kiro.dev, Agent Config → Steering, un archivo `buoh-arranque.md` con este texto.

```markdown
---
inclusion: always
---

# buoh: arranque de sesión

Si el espacio de trabajo contiene el repositorio pedroxynox/buoh, antes de tu primera respuesta lee su archivo .kiro/steering/entorno-sandbox-kiro.md y sigue su «Arranque de sesión».
```

Si una sesión empieza sin seguir estos pasos, el propietario puede pedirlo en su primer mensaje con la última frase de ese texto.

## Comunicación con el propietario

- En el chat, hablar con la skill `caveman`, en español, desde la primera respuesta y durante toda la sesión, también después de un resumen de contexto. Solo se apaga si el propietario dice «stop caveman» o «normal mode».
- Caveman es solo para el chat. Código, comentarios, commits, PR, ADR y documentos siguen el estilo normal del repositorio, y el PR se entiende sin la conversación (`AGENTS.md`, «Relevo entre modelos»). El detalle técnico va en el PR, no en el chat.
- El propietario no es programador. Explicar en español sencillo, con frases cortas y sin jerga; si hace falta un término técnico, decir qué significa.
- Ante conflicto o decisión ausente, seguir el protocolo de `AGENTS.md`. Los detalles técnicos que ese protocolo deja al agente se resuelven investigando, sin trasladarlos al propietario.
- Cuando el protocolo pida una decisión humana (producto, dinero, riesgo o seguridad), explicar al propietario las opciones y la recomendación en palabras simples. Las preguntas y los avisos de seguridad van en frases completas.
- Actualizar el estado de la sesión de Kiro cada vez que cambie la tarea: el propietario lo mira para saber qué pasa.
- Al terminar, dejar el PR listo con las condiciones de `AGENTS.md` («Fusión») y dar al propietario el enlace y un resumen corto de lo que cambia y de si necesita algo más que su fusión. El agente no fusiona: fusiona el propietario.

## Comandos y GitHub

- El Node global del sandbox puede no ser el fijado, y dentro del repositorio `npm` y `npx` fallan con `EBADDEVENGINES`. Ejecutar todo con `pnpm`, que descarga y usa el Node de `devEngines` en `package.json`.
- Si una herramienta larga se corta, por ejemplo la revisión semántica, volver a lanzarla y avisar al propietario en una línea. Relanzar una revisión que se cortó no cuenta como una segunda revisión semántica.
- Antes de cada commit, ejecutar `DOCS_BASE_REF=origin/main pnpm run verify:pr` y confirmar que el código de salida es 0. El final del log no basta: un fallo de tipos puede quedar más arriba.
- Los subcomandos `gh pr` y `gh issue` no funcionan aquí, y `gh run list` tampoco. Crear el PR con `gh api repos/pedroxynox/buoh/pulls -f title=… -F body=@<archivo> -f head=<rama> -f base=main` y revisar CI con `gh api repos/pedroxynox/buoh/commits/<sha>/check-runs`.
- El comentario de PR listo se deja con `gh api repos/pedroxynox/buoh/issues/<n>/comments -F body=@<archivo>`. El agente no llama a la API de fusión (`PUT …/pulls/<n>/merge`). Para saber si el propietario ya fusionó: `gh api repos/pedroxynox/buoh/pulls/<n> --jq .merged_at`.
- Guardar cuerpos de PR, logs y binarios auxiliares fuera del repo, por ejemplo en `/projects/sandbox/.buoh-local/`.

## PostgreSQL y SeaweedFS sin Docker

Docker y podman no arrancan en el sandbox y `dnf` no puede instalar paquetes. CI sigue usando las imágenes fijadas de `infra/compose.yaml`; esta alternativa solo sirve para ejecutar `pnpm run test:integration` dentro del sandbox.

- `/tmp` no se conserva entre comandos y los procesos en segundo plano mueren al terminar cada comando. Arrancar los servicios, ejecutar las pruebas y detenerlos en un mismo comando, con un script auxiliar fuera del repo.
- **PostgreSQL 18.4 portátil** (CI usa 18.6, así que una diferencia de versión menor puede separar ambos resultados):
  1. `npm pack @embedded-postgres/linux-x64@18.4.0-beta.17`, comprobar que el `.tgz` tiene SHA-256 `795d587bb466423385db256dc81e61f2ee40c9e10efde21e881f3e997dd1bdb2` y extraerlo.
  2. Recrear los enlaces de `native/pg-symlinks.json` con `fs.symlinkSync(basename(source), target)` y dar permiso de ejecución a `native/bin/*`.
  3. Usar `LD_LIBRARY_PATH=<paquete>/native/lib`. `initdb` y `postgres` no corren como root: ejecutarlos con `setpriv --reuid=nobody --regid=nobody --clear-groups`.
  4. `initdb -D <datos> -U buoh --pwfile=<archivo> -A scram-sha-256 -E UTF8 --locale=C`.
  5. `postgres -D <datos> -k <dir-socket> -h 127.0.0.1 -p 55432`.
- **SeaweedFS 4.48:** descargar `https://github.com/seaweedfs/seaweedfs/releases/download/4.48/linux_amd64.tar.gz` y comprobar su SHA-256 `4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124`. Ejecutar `weed mini -dir=<datos> -ip=127.0.0.1 -ip.bind=127.0.0.1 -master.telemetry=false -webdav=false -admin.ui=false` con `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `S3_BUCKET=buoh-local`. Sin `-ip.bind`, `mini` escucha en todas las interfaces, incluidos componentes sin autenticación que ADR-0005 §1 mantiene fuera de la red. Con esas opciones todo queda en `127.0.0.1` y S3 responde en `127.0.0.1:8333`.
- **Variables:** exportar las `BUOH_*` de `infra/.env.example` con `BUOH_DEPLOYMENT_ENVIRONMENT=test`, `BUOH_POSTGRES_PORT=55432` y `BUOH_POSTGRES_DB=postgres`. `BUOH_POSTGRES_PASSWORD` es el contenido del `--pwfile`, y `BUOH_S3_ACCESS_KEY_ID` y `BUOH_S3_SECRET_ACCESS_KEY` son los mismos valores de `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` que recibe `weed`.
- **Credenciales:** generarlas en cada sandbox con `openssl rand -hex 24` y guardarlas fuera del repo. Nunca escribirlas en commits, PR ni mensajes.
