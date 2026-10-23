---
inclusion: always
---

# Trabajo en el sandbox de Kiro Web

Notas prácticas para sesiones de Kiro. No deciden nada: el proceso está en [`AGENTS.md`](../../AGENTS.md) y [`CONTRIBUTING.md`](../../CONTRIBUTING.md), el estado y la siguiente tarea en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y el entorno local canónico en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

## Comunicación con el propietario

- El propietario no es programador. Explicar en español sencillo, con frases cortas y sin jerga; si hace falta un término técnico, decir qué significa.
- Elegir la opción técnica más conveniente dentro de las fuentes canónicas y registrar el supuesto en el PR, según el protocolo ante vacíos de `AGENTS.md`.
- Preguntar antes de una decisión que cambie riesgo, producto, datos, contratos, seguridad o alcance y que las fuentes canónicas no resuelvan.
- Al terminar, dar el enlace del PR y esperar a que el propietario lo fusione.

## Comandos y GitHub

- El Node global del sandbox puede no ser el fijado. Ejecutar todo con `pnpm`, que descarga y usa el Node de `devEngines` en `package.json`.
- Antes de cada commit, ejecutar `DOCS_BASE_REF=origin/main pnpm run verify:pr` y confirmar que el código de salida es 0. El final del log no basta: un fallo de tipos puede quedar más arriba.
- Los subcomandos `gh pr` y `gh issue` no funcionan aquí, y `gh run list` tampoco. Crear el PR con `gh api repos/pedroxynox/buoh/pulls -f title=… -F body=@<archivo> -f head=<rama> -f base=main` y revisar CI con `gh api repos/pedroxynox/buoh/commits/<sha>/check-runs`.
- Guardar cuerpos de PR, logs y binarios auxiliares fuera del repo, por ejemplo en `/projects/sandbox/.buoh-local/`.

## PostgreSQL y SeaweedFS sin Docker

Docker y podman no arrancan en el sandbox y `dnf` no puede instalar paquetes. CI sigue usando las imágenes fijadas de `infra/compose.yaml`; esta alternativa solo sirve para ejecutar `pnpm run test:integration` dentro del sandbox.

- `/tmp` no se conserva entre comandos y los procesos en segundo plano mueren al terminar cada comando. Arrancar los servicios, ejecutar las pruebas y detenerlos en un mismo comando, con un script auxiliar fuera del repo.
- **PostgreSQL 18 portátil:**
  1. `npm pack @embedded-postgres/linux-x64@18.4.0-beta.17` y extraer el paquete.
  2. Recrear los enlaces de `native/pg-symlinks.json` con `fs.symlinkSync(basename(source), target)` y dar permiso de ejecución a `native/bin/*`.
  3. Usar `LD_LIBRARY_PATH=<paquete>/native/lib`. `initdb` y `postgres` no corren como root: ejecutarlos con `setpriv --reuid=nobody --regid=nobody --clear-groups`.
  4. `initdb -D <datos> -U buoh --pwfile=<archivo> -A scram-sha-256 -E UTF8 --locale=C`.
  5. `postgres -D <datos> -k <dir-socket> -h 127.0.0.1 -p 55432`.
- **SeaweedFS 4.48:** descargar `https://github.com/seaweedfs/seaweedfs/releases/download/4.48/linux_amd64.tar.gz` y ejecutar `weed mini -dir=<datos> -master.telemetry=false -webdav=false -admin.ui=false` con `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `S3_BUCKET=buoh-local`. Expone S3 en `127.0.0.1:8333`.
- **Variables:** exportar las `BUOH_*` de `infra/.env.example` con `BUOH_DEPLOYMENT_ENVIRONMENT=test`, `BUOH_POSTGRES_PORT=55432` y `BUOH_POSTGRES_DB=postgres`.
- **Credenciales:** generarlas en cada sandbox con `openssl rand -hex 24` y guardarlas fuera del repo. Nunca escribirlas en commits, PR ni mensajes.
