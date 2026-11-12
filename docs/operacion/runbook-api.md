# Runbook de la API de buoh

Los pasos de operación de `buoh-api` (ADR-0019 §3, §10 y §14): desplegar, dar de alta la cuenta, entrar, recuperar, rotar, parar y borrar. El agente no tiene cuenta en producción ni recibe enlaces; estos pasos los hace el propietario desde Render, salvo las comprobaciones desde fuera, que hace el agente. **buoh nunca envía enlaces para entrar:** el propietario los crea él mismo en la consola de Render, y los abre en su navegador.

El Blueprint del sistema de datos es `render-datos.yaml`; qué define está en [despliegue en Render](despliegue-en-render.md). La API se despliega sobre un Blueprint que ya existe (runbook de ingesta, «Producción (F2.2)»).

## Antes de desplegar

- **Verificación en dos pasos en Render y en GitHub.** Quien entre en esas cuentas podría cambiar lo que corre en producción, insertar credenciales o leer los registros. Actívala si no la tienes (como en «Primera conexión» de [despliegue en Render](despliegue-en-render.md)).
- **El gasto.** Fusionar el PR que añade `buoh-api` al Blueprint lo crea en la siguiente sincronización (*Auto Sync*) y **empieza a cobrar** unos 7 USD al mes más (ADR-0019 §10; el total queda en unos 26). Con esa fusión apruebas el gasto (ADR-0016 §3).

## Desplegar

Si el comentario de listo de un PR dice que cambia `render-datos.yaml`, y después de ese comentario fusionaste otro PR, no lo fusiones todavía: pídele al agente que lo actualice. Una sincronización del Blueprint puede desplegar sin esperar a CI, y así lo que se despliega es lo que CI ya probó ([despliegue en Render](despliegue-en-render.md), «Cuándo despliegan»).

1. Fusiona en `main` el PR de despliegue. Render sincroniza el Blueprint al recibir el push y crea el servicio `buoh-api`. En su primer cron, `buoh-operaciones` crea el rol `buoh_api`, migra su esquema y le pone la contraseña que Render generó (ADR-0019 §7); hasta entonces, `GET /api/salud` responde `503 not_ready`.
2. **Mira si el Blueprint dejó algo pendiente.** Si llegó un email «Blueprint sync failed», antes de nada abre **Blueprints**, el del sistema de datos, pásale al agente el error que muestra, o una captura, y espera su respuesta: él te dice cuándo sincronizar y qué aprobar. Si no llegó ese email, abre **Blueprints**, el del sistema de datos, y pulsa **Manual Sync**, y si aparece un cambio con un botón **Approve**, apruébalo. El 2026-11-03, Render creó `buoh-api` pero dejó así la variable `BUOH_API_POSTGRES_PASSWORD` de `buoh-operaciones`, y sin ella `buoh-operaciones` no prepara la base de la API ([evidencia](evidencia-api-f2-3.md)). El 2026-11-04, la sincronización falló sin decir por qué y no creó una variable nueva de `buoh-operaciones`, y una **Manual Sync** con **Approve** la creó (abajo, «La credencial de lectura de los datos»).
3. En el panel de `buoh-api`, espera a que el despliegue termine y la salud (`/api/salud`) quede verde. La dirección aparece en la página del servicio, con la forma `https://buoh-api….onrender.com`.
   - **Si termina en `Timed Out`** (Render espera 15 minutos a que `/api/salud` responda `200`): aprueba primero lo pendiente del paso 2. Después, en `buoh-operaciones`, pulsa **Trigger Run** y espera a que termine en verde. Por último, en `buoh-api`, pulsa **Manual Deploy** y después **Deploy latest commit**.
4. **Si Render dio una dirección distinta de `https://buoh-api.onrender.com`** (porque el nombre estaba ocupado), cambia `BUOH_API_ORIGIN` en `render-datos.yaml` a esa dirección exacta (sin barra final) y vuelve a fusionar: el `Origin` tiene que coincidir, o la web no puede cambiar nada (CSRF, ADR-0019 §2). Pásale la dirección al agente.
5. El agente comprueba desde fuera lo que pide ADR-0019 §13 (abajo, «Comprobar desde fuera»).

### La credencial de lectura de los datos

El PR de la salud de los datos de F2.4 (#91) sumó `BUOH_API_LECTURA_POSTGRES_PASSWORD`, la contraseña del rol `buoh_api_lectura` (ADR-0019 §7 y §8): Render la genera en `buoh-api`, y `buoh-operaciones` la toma de ahí (`fromService`). Al fusionarlo se desplegaron los tres servicios: `buoh-ingesta`, con un corte de unos segundos en la captura, `buoh-operaciones` y `buoh-api`. El propietario lo fusionó el 2026-11-04, y pasó esto ([evidencia de F2.4](evidencia-datos-f2-4.md)):

- La sincronización automática del Blueprint creó la variable en `buoh-api` y desplegó la API sin esperar a CI. En `buoh-operaciones` no la creó, y llegó un email «Blueprint sync failed for buoh-datos», sin el motivo. No se rompió nada: la API arrancó igual, y solo `GET /api/v1/datos/salud` habría respondido `503` mientras faltaba el rol.
- Cuando terminaron los despliegues, el propietario pulsó **Manual Sync** y aprobó con **Approve** la variable de `buoh-operaciones`.
- En su ejecución siguiente, la de las 20:50 UTC, `buoh-operaciones` creó `buoh_api_lectura`, miembro de `buoh_lectura`, y le puso la contraseña: su informe `roles_and_logs` lleva `buoh_api_lectura` en `passwords_set`. El agente comprobó con su acceso («Acceso del agente», en el runbook de ingesta) que el rol inicia sesión, no tiene `CREATEROLE` y solo es miembro de `buoh_lectura`.
- Con su sesión abierta, el propietario vio en la ruta la salud `healthy` del log 2.

**Si vuelve a pasar**, con un PR que añada una variable que copia otra nueva de otro servicio, sigue el paso 2 de arriba: el agente te dice cuándo sincronizar y qué aprobar. Después, el agente comprueba lo que crea `buoh-operaciones` en su ejecución siguiente, unos 30 s después de cada minuto múltiplo de 5.

### El token `api` de R2

El PR de las lecturas de R2 de F2.4 (el 5a) suma el token `api`, de solo lectura sobre `buoh-captura`, con el que `buoh-api` lee el gráfico y el catálogo (ADR-0019 §8). Como el Blueprint ya existe, Render no pide sus valores: los pegas tú. Sin ellos, esas dos rutas responden `503 not_ready`, y lo demás de la API funciona igual. Hazlo el día que fusiones ese PR, desde el 2026-11-08, en este orden:

1. **En Cloudflare**, crea el token como los otros: **R2 Object Storage**, **Account Details**, **Manage** junto a **API Tokens** y **Create Account API token**. Nombre `api`, permiso **Object Read only**, **Apply to specific buckets only** con `buoh-captura`, y **TTL** *Forever*. Cloudflare muestra su **Secret Access Key** una sola vez: deja la página abierta hasta terminar el paso 2.
2. **En Render**, en `buoh-api`, abre **Environment**, añade estas tres variables y guarda con **Save only**, que no despliega:

   | Variable | Valor |
   |---|---|
   | `BUOH_API_S3_ENDPOINT` | el endpoint de los otros tokens, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, sin el bucket ni nada detrás: copia el valor de `BUOH_SALUD_S3_ENDPOINT`, en **Environment** de `buoh-operaciones` |
   | `BUOH_API_S3_ACCESS_KEY_ID` | el **Access Key ID** del token `api` |
   | `BUOH_API_S3_SECRET_ACCESS_KEY` | su **Secret Access Key** |

   Nunca los pegues en el chat ni en Git. `BUOH_API_S3_BUCKET` y `BUOH_API_S3_REGION` los pone el Blueprint. El código que corre hoy no lee estas variables, así que guardarlas no cambia nada hasta el paso 3.
3. **Fusiona el PR.** Si su comentario de listo dice que cambia `render-datos.yaml` y después fusionaste otro PR, pídele antes al agente que lo actualice (arriba, «Desplegar»). Render despliega `buoh-api` con las variables nuevas y, como el PR cambia el worker, también `buoh-ingesta` y `buoh-operaciones`.
4. **Mira si el Blueprint dejó algo pendiente**, como en el paso 2 de «Desplegar».
5. **Comprueba el token.** Cuando termine el despliegue, con tu sesión abierta (abajo, «Para ver una ruta de datos en el navegador»), abre `https://<dirección>/api/v1/datos/catalogo` y `https://<dirección>/api/v1/datos/grafico?hours=1`, y pásale al agente lo que ves, que no lleva ningún secreto. Con el token bien puesto, la primera trae el catálogo de Deriv y la segunda, los ticks de la última hora.
   - `503 not_ready`: la API que corre no tiene ninguna de las tres variables, porque no se guardaron o porque se guardaron después del despliegue. Comprueba que están las tres y pulsa **Manual Deploy** y después **Deploy latest commit**.
   - `404 not_found`: todavía responde la versión anterior, que no tiene estas rutas. O el despliegue no terminó, y basta con esperar, o falló: con una o dos de las tres variables, o con una que no vale, la versión nueva no arranca (abajo).
   - `503 storage_unavailable`: R2 rechazó el token o no respondió. Revisa en Cloudflare que el token `api` tiene **Object Read only** sobre `buoh-captura`, y en Render que las dos claves son las suyas.
   - Si el despliegue falla y en los **Logs** de `buoh-api` sale `api_config_error`, la línea nombra la variable que no vale: una vacía, o un endpoint con el bucket o una barra al final. Corrígela y guarda con **Save and deploy**. Si nombra `BUOH_API_S3_BUCKET` o `BUOH_API_S3_REGION`, no las añadas a mano: las pone el Blueprint, así que su sincronización no terminó (paso 4). Mientras tanto, Render sigue sirviendo la versión anterior.

**Para ver una ruta de datos en el navegador**, como `https://<dirección>/api/v1/datos/salud`, que no lleva ningún secreto:

1. Entra en `https://<dirección>/acceso` con tu usuario, tu contraseña y el código de 6 cifras.
2. Comprueba que tienes la sesión abierta: al pulsar **Propietario**, arriba a la derecha, aparece **Cerrar sesión**. En el teléfono no se ve la palabra **Propietario**, solo el icono de una persona: púlsalo. Mientras la web lee la sesión, ese botón está, pero no abre el menú.
3. Escribe la dirección en la barra de direcciones del navegador, o elígela de sus sugerencias, y pásale al agente lo que ves. Si llegas desde un enlace de otra página, como el chat del agente, tu navegador no envía la sesión, y la respuesta es `401 unauthenticated` (ADR-0019 §2).

## Dar de alta tu cuenta (enseguida, justo después de desplegar)

Hazlo **cuanto antes**. Hasta que tu cuenta esté dada de alta, alguien con la contraseña del rol de la base podría insertar una credencial falsa y adelantarse (ADR-0019, «Consecuencias», «La contraseña del rol de la API»).

1. En el panel de `buoh-api`, abre **Shell** (los servicios web de pago de Render la tienen).
2. Corre la orden del alta, con el entorno del servicio:

   ```sh
   node apps/api/dist/cli/cuenta.js alta <tu-usuario>
   ```

   Cambia `<tu-usuario>` por tu nombre, **sin** los signos `<` y `>`: con el nombre `ejemplo-1`, sería `node apps/api/dist/cli/cuenta.js alta ejemplo-1`. Que no sea tu nombre público, para que nadie lo adivine (ADR-0019 §1). Con esos signos, bash responde `syntax error near unexpected token 'newline'`. Si al pegar aparece `^[[200~` delante de la orden, bórralo o escribe la orden a mano. El usuario tiene de 3 a 32 caracteres: minúsculas sin acentos, cifras, `-` y `_`. Escribe en pantalla lo que es el enlace, su vencimiento y su dirección, `https://<dirección>/enlace/#<token>`. Nadie más ve ese token: la base solo guarda su huella. Vale **15 minutos** y un solo uso.
3. Abre esa dirección en tu navegador. Escanea el **QR** con tu app de autenticación (o escribe el código a mano), elige una **contraseña** de al menos 15 caracteres y confirma con un **código de 6 cifras**.
4. El alta no abre sesión: ve a `https://<dirección>/acceso` e inicia sesión.

En `production`, `alta` solo crea el enlace si todavía no hay ninguna cuenta dada de alta; si repites el alta antes de terminarla, el enlace nuevo anula el anterior.

## Entrar

- `https://<dirección>/acceso`: tu usuario, tu contraseña y un código de 6 cifras, los tres juntos. Ante cualquier dato incorrecto, el mismo mensaje, sin decir cuál falló.
- La sesión dura como mucho 24 horas, y se cierra sola tras 1 hora sin actividad.
- El menú de arriba, en «Propietario», cierra tu sesión o cierra las demás sesiones (si entraste desde otro dispositivo).

## Recuperar (contraseña o código perdidos)

1. En la **Shell** de `buoh-api`:

   ```sh
   node apps/api/dist/cli/cuenta.js restablecer <tu-usuario>
   ```

   Con tu nombre en lugar de `<tu-usuario>`, sin los signos `<` y `>`, como en el alta. Da un enlace nuevo, como el del alta.
2. Úsalo igual: contraseña y código nuevos. Al terminar, la credencial anterior queda deshabilitada y se cierran **todas** tus sesiones.

Si pierdes también el acceso a la Shell, entra por la base: con la credencial dueña puedes borrar la cuenta y volver a empezar, pero es el último recurso.

## Rotar credenciales

Se rota si una credencial se filtra o cuando quieras. Nada de esto se pide por chat.

- **La contraseña del rol `buoh_api`** (la de la base): se rota como en [ADR-0018 §12](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md). `buoh-operaciones` vuelve a ponérsela al rol en su paso 1.
- **La contraseña de `buoh_api_lectura`** (`BUOH_API_LECTURA_POSTGRES_PASSWORD`, en `buoh-api`): igual, con los pasos de «La contraseña de un rol de ejecución» del runbook de ingesta («Rotar credenciales»). Mientras `buoh-operaciones` no le pone la nueva, solo las rutas de datos responden `503 postgres_unavailable`; lo demás de la API sigue.
- **El token `api` de R2** (`BUOH_API_S3_ACCESS_KEY_ID` y `BUOH_API_S3_SECRET_ACCESS_KEY`, en `buoh-api`): como «Un token de R2» del runbook de ingesta («Rotar credenciales»). Crea otro igual en Cloudflare, cambia esas dos variables en `buoh-api` y guarda con **Save and deploy**. Cuando el gráfico vuelva a responder (arriba, «El token `api` de R2», paso 5), borra el viejo. Mientras tanto, solo el gráfico y el catálogo pueden responder `503 storage_unavailable`.
- **`BUOH_API_PASSWORD_PEPPER` o `BUOH_API_TOTP_KEY`:** cámbialas en el panel de `buoh-api` (o deja que Render genere otra). Dejan **inservible** la credencial guardada, así que después haz un `restablecer` (arriba).
- **`BUOH_API_TOKEN_KEY`:** cambiarla **cierra todas las sesiones** y anula los enlaces sin usar. La contraseña y el código siguen valiendo.

Las tres claves son de 256 bits y viven fuera de la base; cambiar la contraseña del rol no basta para entrar, porque las sesiones y las credenciales dependen de estas claves (ADR-0019, «Consecuencias»).

## Parar

- **Suspender:** en la configuración de `buoh-api`, **Suspend**. La dirección responde un error mientras está suspendido; **Resume** para volver. La base y la captura siguen.
- Con `SIGTERM` (un despliegue o una parada), la API deja de aceptar peticiones y termina las que están en curso antes de salir.

## Borrar

Borra la API entera, no la base ni la captura de datos:

1. Quita el servicio `buoh-api` de `render-datos.yaml` y las variables `BUOH_API_POSTGRES_PASSWORD` y `BUOH_API_LECTURA_POSTGRES_PASSWORD` de `buoh-operaciones`, que las toman de `buoh-api`, y fusiona.
2. Borra `buoh-api` en el panel de Render. Si solo lo borras del panel, Render lo recrea en la siguiente sincronización del Blueprint. Borra también el token `api` en Cloudflare: con el servicio, nadie lo usa.
3. El esquema `buoh_api` y los roles `buoh_api` y `buoh_api_lectura` quedan en la base. Bórralos a mano con la credencial dueña solo si quieres; una fila nunca se borra sola (ADR-0019 §7).

## Comprobar desde fuera (lo hace el agente)

Con la dirección del servicio en lugar de `<dirección>`:

```sh
curl -sI https://<dirección>/api/salud
curl -s -o /dev/null -w '%{http_code}\n' https://<dirección>/api/v1/desconocida
curl -s https://<dirección>/api/v1/datos/salud
curl -s https://<dirección>/api/v1/datos/eventos
curl -s 'https://<dirección>/api/v1/datos/grafico?hours=1'
curl -s https://<dirección>/api/v1/datos/catalogo
```

- `/api/salud` responde `200` cuando la API responde y tiene sus migraciones; si le faltan, `503 not_ready`.
- Toda respuesta lleva las cabeceras de seguridad de §9 (`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `X-Frame-Options`, `X-Robots-Tag`); el HTML, su política de contenido con los hashes de sus scripts en línea; el JSON y los demás archivos de la web, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; y el JSON, `Cache-Control: no-store` (`F2-API-001`).
- Una ruta `/api/` que no existe responde `404 not_found` en JSON; cualquier otra ruta desconocida, el `404.html` de la web.
- `GET /api/v1/datos/salud`, `GET /api/v1/datos/eventos`, `GET /api/v1/datos/grafico?hours=1` y `GET /api/v1/datos/catalogo` sin sesión responden `401 unauthenticated`: las rutas existen y no dan nada sin sesión.
- La comprobación completa de §13 incluye que ninguna respuesta ni ningún registro lleva la contraseña, el secreto TOTP, los códigos, el identificador de la sesión, el token CSRF, el del enlace ni las tres claves, cada uno solo en su canal (`F2-API-001`, `F2-AUTH-001`).

### El límite por dirección

La API cuenta los intentos fallidos y las peticiones por la dirección de `CF-Connecting-IP`, que pone Cloudflare, delante de Render (ADR-0019 §1). Si esa cabecera falta, cuenta la de la conexión, que en Render es un proxy suyo, y los límites dejarían de contar por cliente sin que nada lo avise. Render no documenta la cabecera, así que estas dos comprobaciones se repiten en cada evidencia.

**Los intentos fallidos.** Son doce inicios de sesión fallidos seguidos, cada uno con un nombre distinto que no existe, para que solo cuente el límite por dirección, y con un `X-Forwarded-For` y un `True-Client-IP` distintos. El último lleva además una `CF-Connecting-IP` vacía, que Cloudflare deja pasar:

```sh
intento() {
  curl -s -D /tmp/cabeceras -o /tmp/cuerpo -w '%{http_code} ' -X POST https://<dirección>/api/v1/sesion \
    -H 'Origin: https://<dirección>' -H 'Content-Type: application/json' \
    -H "X-Forwarded-For: 203.0.113.$1" -H "True-Client-IP: 203.0.113.$1" "${@:2}" \
    --data "{\"username\":\"prueba-limite-$1\",\"password\":\"no-es-una-contrasena\",\"code\":\"000000\"}"
  echo "$(cat /tmp/cuerpo) set-cookie: $(grep -ci '^set-cookie' /tmp/cabeceras)"
}
for i in $(seq 1 11); do intento "$i"; done
intento 12 -H 'CF-Connecting-IP;'
```

- Los diez primeros responden `401` con `invalid_credentials`, y los dos últimos, `429` con `rate_limited` y los segundos que faltan en `retry_after_seconds`: cambiar esas cabeceras, o mandar `CF-Connecting-IP` vacía, no esquiva el límite. Ninguno trae `set-cookie`.
- Un `401` en el último diría que la cabecera vacía saca al cliente de su límite: entonces la regla de §1 se corrige antes de seguir.
- Mientras dura la espera, unos 15 minutos, el propietario entra desde su casa: dos redes distintas cuentan por separado (ADR-0019 §13).
- Una petición que trae `CF-Connecting-IP` con un valor la rechaza Cloudflare con `403`, antes de llegar a la API.
- Los intentos quedan en la auditoría como fallos sin cuenta, que la sección Auditoría del propietario no muestra.
- Nunca con el nombre del propietario: sus fallos cuentan para su límite por nombre y para el tope de 100, que deshabilita su credencial (ADR-0019 §1).

**El límite general**, de 120 peticiones por minuto, se comprueba solo con GET, sin crear ninguna entrada en la auditoría. Las 121 peticiones tienen que caber en un minuto:

```sh
for i in $(seq 1 121); do
  curl -s -o /dev/null -w '%{http_code}\n' https://<dirección>/api/salud
done | sort | uniq -c
```

Tienen que salir 120 `200` y un `429`. Con 121 `200`, el límite no cuenta por cliente.
