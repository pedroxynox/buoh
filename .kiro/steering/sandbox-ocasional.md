---
inclusion: manual
---

# Tareas ocasionales en el sandbox de Kiro Web

No se lee al arrancar. Se lee antes de cambiar de sesión o de cuenta de Kiro, y antes de correr `pnpm run test:integration` dentro del sandbox. Lo que vale en cada sesión está en [`entorno-sandbox-kiro.md`](entorno-sandbox-kiro.md). Estas dos secciones estaban allí hasta el 2026-11-21 y pasaron con el mismo texto, salvo la referencia a «Arranque de sesión», que ahora nombra su archivo.

## Cambio de sesión

Una sesión nueva no ve la conversación anterior, y puede no ver lo guardado fuera del repositorio, como `/projects/sandbox/.buoh-local/`. Cuando el propietario va a cambiar de sesión:

1. Llevar a un PR lo que el repositorio todavía no recoge: las decisiones del propietario, con sus palabras y su fecha, las mediciones y los pendientes.
2. Darle un mensaje para la sesión nueva que remita al repositorio, nombre los PR abiertos y diga cuál es la siguiente tarea. Si ese mensaje y el repositorio difieren, manda el repositorio.
3. Si pasa a otra cuenta de Kiro, el propietario, en la cuenta nueva: conecta su cuenta de GitHub, para que la sesión pueda abrir `pedroxynox/buoh` y `gh` actúe con ella; crea su steering personal `buoh-arranque.md` («Arranque de sesión» de [`entorno-sandbox-kiro.md`](entorno-sandbox-kiro.md)); y guarda los cinco secretos `BUOH_AGENTE_*`. Cuando una sesión de la cuenta nueva, abierta después de guardarlos, los ve y su `data:health` da `healthy`, los borra de la cuenta anterior (runbook, «Acceso del agente», «Otra cuenta de Kiro»). Lo demás no hace falta pasarlo: las skills las instala el arranque, y los servicios de las pruebas de integración se vuelven a montar con «PostgreSQL y SeaweedFS sin Docker». Lo que quedó en `/projects/sandbox/.buoh-local/` y los informes de las revisiones semánticas se pierden, así que lo que importa tiene que estar antes en el repositorio o en los PR.

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
