# Runbook de la API de buoh

Los pasos de operación de `buoh-api` (ADR-0019 §3, §10 y §14): desplegar, dar de alta la cuenta, entrar, recuperar, rotar, parar y borrar. El agente no tiene cuenta en producción ni recibe enlaces; estos pasos los hace el propietario desde Render, salvo las comprobaciones desde fuera, que hace el agente. **buoh nunca envía enlaces para entrar:** el propietario los crea él mismo en la consola de Render, y los abre en su navegador.

El Blueprint del sistema de datos es `render-datos.yaml`; qué define está en [despliegue en Render](despliegue-en-render.md). La API se despliega sobre un Blueprint que ya existe (runbook de ingesta, «Producción (F2.2)»).

## Antes de desplegar

- **Verificación en dos pasos en Render y en GitHub.** Quien entre en esas cuentas podría cambiar lo que corre en producción, insertar credenciales o leer los registros. Actívala si no la tienes (como en «Primera conexión» de [despliegue en Render](despliegue-en-render.md)).
- **El gasto.** Fusionar el PR que añade `buoh-api` al Blueprint lo crea en la siguiente sincronización (*Auto Sync*) y **empieza a cobrar** unos 7 USD al mes más (ADR-0019 §10; el total queda en unos 26). Con esa fusión apruebas el gasto (ADR-0016 §3).

## Desplegar

1. Fusiona en `main` el PR de despliegue. Cuando CI pase, Render sincroniza el Blueprint y crea el servicio `buoh-api`. En su primer cron, `buoh-operaciones` crea el rol `buoh_api`, migra su esquema y le pone la contraseña que Render generó (ADR-0019 §7); hasta entonces, `GET /api/salud` responde `503 not_ready`.
2. En el panel de `buoh-api`, espera a que el despliegue termine y la salud (`/api/salud`) quede verde. La dirección aparece en la página del servicio, con la forma `https://buoh-api….onrender.com`.
3. **Si Render dio una dirección distinta de `https://buoh-api.onrender.com`** (porque el nombre estaba ocupado), cambia `BUOH_API_ORIGIN` en `render-datos.yaml` a esa dirección exacta (sin barra final) y vuelve a fusionar: el `Origin` tiene que coincidir, o la web no puede cambiar nada (CSRF, ADR-0019 §2). Pásale la dirección al agente.
4. El agente comprueba desde fuera lo que pide ADR-0019 §13 (abajo, «Comprobar desde fuera»).

## Dar de alta tu cuenta (enseguida, justo después de desplegar)

Hazlo **cuanto antes**. Hasta que tu cuenta esté dada de alta, alguien con la contraseña del rol de la base podría insertar una credencial falsa y adelantarse (ADR-0019, «Consecuencias», «La contraseña del rol de la API»).

1. En el panel de `buoh-api`, abre **Shell** (los servicios web de pago de Render la tienen).
2. Corre la orden del alta, con el entorno del servicio:

   ```sh
   node apps/api/dist/cli/cuenta.js alta <tu-usuario>
   ```

   El usuario tiene de 3 a 32 caracteres: minúsculas sin acentos, cifras, `-` y `_`. Escribe en pantalla lo que es el enlace, su vencimiento y su dirección, `https://<dirección>/enlace/#<token>`. Nadie más ve ese token: la base solo guarda su huella. Vale **15 minutos** y un solo uso.
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

   Da un enlace nuevo, como el del alta.
2. Úsalo igual: contraseña y código nuevos. Al terminar, la credencial anterior queda deshabilitada y se cierran **todas** tus sesiones.

Si pierdes también el acceso a la Shell, entra por la base: con la credencial dueña puedes borrar la cuenta y volver a empezar, pero es el último recurso.

## Rotar credenciales

Se rota si una credencial se filtra o cuando quieras. Nada de esto se pide por chat.

- **La contraseña del rol `buoh_api`** (la de la base): se rota como en [ADR-0018 §12](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md). `buoh-operaciones` vuelve a ponérsela al rol en su paso 1.
- **`BUOH_API_PASSWORD_PEPPER` o `BUOH_API_TOTP_KEY`:** cámbialas en el panel de `buoh-api` (o deja que Render genere otra). Dejan **inservible** la credencial guardada, así que después haz un `restablecer` (arriba).
- **`BUOH_API_TOKEN_KEY`:** cambiarla **cierra todas las sesiones** y anula los enlaces sin usar. La contraseña y el código siguen valiendo.

Las tres claves son de 256 bits y viven fuera de la base; cambiar la contraseña del rol no basta para entrar, porque las sesiones y las credenciales dependen de estas claves (ADR-0019, «Consecuencias»).

## Parar

- **Suspender:** en la configuración de `buoh-api`, **Suspend**. La dirección responde un error mientras está suspendido; **Resume** para volver. La base y la captura siguen.
- Con `SIGTERM` (un despliegue o una parada), la API deja de aceptar peticiones y termina las que están en curso antes de salir.

## Borrar

Borra la API entera, no la base ni la captura de datos:

1. Quita el servicio `buoh-api` de `render-datos.yaml` y la variable `BUOH_API_POSTGRES_PASSWORD` de `buoh-operaciones`, y fusiona.
2. Borra `buoh-api` en el panel de Render. Si solo lo borras del panel, Render lo recrea en la siguiente sincronización del Blueprint.
3. El esquema `buoh_api` y su rol quedan en la base. Bórralos a mano con la credencial dueña solo si quieres; una fila nunca se borra sola (ADR-0019 §7).

## Comprobar desde fuera (lo hace el agente)

Con la dirección del servicio en lugar de `<dirección>`:

```sh
curl -sI https://<dirección>/api/salud
curl -s -o /dev/null -w '%{http_code}\n' https://<dirección>/api/v1/desconocida
```

- `/api/salud` responde `200` cuando la API responde y tiene sus migraciones; si le faltan, `503 not_ready`.
- Toda respuesta lleva las cabeceras de seguridad de §9 (`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `X-Frame-Options`, `X-Robots-Tag`); el HTML, su política de contenido con los hashes de sus scripts en línea; el JSON, `Content-Security-Policy: default-src 'none'` y `Cache-Control: no-store` (`F2-API-001`).
- Una ruta `/api/` que no existe responde `404 not_found` en JSON; cualquier otra ruta desconocida, el `404.html` de la web.
- La comprobación completa de §13 incluye que ninguna respuesta ni ningún registro lleva la contraseña, el secreto TOTP, los códigos, el identificador de la sesión, el token CSRF, el del enlace ni las tres claves, cada uno solo en su canal (`F2-API-001`, `F2-AUTH-001`).
