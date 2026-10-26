---
inclusion: always
---

# Trabajo en el sandbox de Kiro Web

Notas prácticas para sesiones de Kiro. No deciden nada: el proceso está en [`AGENTS.md`](../../AGENTS.md) y [`CONTRIBUTING.md`](../../CONTRIBUTING.md), el estado y la siguiente tarea en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y el entorno local canónico en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

## Comunicación con el propietario

- El propietario no es programador. Explicar en español sencillo, con frases cortas y sin jerga; si hace falta un término técnico, decir qué significa.
- Ante conflicto o decisión ausente, seguir el protocolo de `AGENTS.md`. Los detalles técnicos que ese protocolo deja al agente se resuelven investigando, sin trasladarlos al propietario.
- Cuando el protocolo pida una decisión humana, explicar al propietario las opciones y la recomendación en palabras simples.
- Al terminar, fusionar el PR con las condiciones de `AGENTS.md` («Fusión») y dar al propietario su enlace y un resumen corto.

## Comandos y GitHub

- El Node global del sandbox puede no ser el fijado. Ejecutar todo con `pnpm`, que descarga y usa el Node de `devEngines` en `package.json`.
- Antes de cada commit, ejecutar `DOCS_BASE_REF=origin/main pnpm run verify:pr` y confirmar que el código de salida es 0. El final del log no basta: un fallo de tipos puede quedar más arriba.
- Los subcomandos `gh pr` y `gh issue` no funcionan aquí, y `gh run list` tampoco. Crear el PR con `gh api repos/pedroxynox/buoh/pulls -f title=… -F body=@<archivo> -f head=<rama> -f base=main` y revisar CI con `gh api repos/pedroxynox/buoh/commits/<sha>/check-runs`.
- Para fusionar: primero el comentario con `gh api repos/pedroxynox/buoh/issues/<n>/comments -f body=…`, y después `gh api -X PUT repos/pedroxynox/buoh/pulls/<n>/merge -f merge_method=merge`.
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
