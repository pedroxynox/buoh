# ADR-0023: Motor de investigación y su VPS (F2.6b)

- **Estado:** Aceptada
- **Fecha:** 2026-11-16
- **Ámbito:** Fase 2, incremento F2.6b (`F2-RESEARCH-001`, `F2-SEARCH-001` en lo del registro y los controles negativos, `F2-AUDIT-001` en lo de las búsquedas y la credencial del motor y `F2-GOV-001` para `research/python`, del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 10). Fija también lo que toman de ella F2.7 (los backtests de la búsqueda en el VPS, `F2-BACKTEST-001`) y F2.8 (la congelación, con su auditoría, y la réplica y la prueba fuera de muestra en la API, `F2-SEARCH-001` y `F2-EVAL-001`).
- **Decisores:** Propietario de buoh (el motor en Python y en un VPS propio, que lo administre él y solo él tenga acceso, el VPS-2 de OVHcloud, seguir en Render y Linux, con la distribución que le recomendó el agente, Ubuntu 26.04 LTS, decididos el 2026-11-16; plan §12), a propuesta de la dirección técnica (lo demás, también la región, la credencial del motor y la actualización sola).
- **Complementa:** [ADR-0003](0003-lenguajes-y-limites.md), con la versión de Python y las bibliotecas del motor (§2); [ADR-0018](0018-sistema-de-datos-en-produccion.md) §10 y §12, con un bucket y cuatro tokens de R2 nuevos (§7); [ADR-0019](0019-api-cuentas-y-auditoria.md) §2, §3, §4, §5, §7, §10 y §12, con la credencial del motor, sus objetos, su autor en la auditoría, su rotación y lo que corre en el proceso hijo de la API (§1 y §5); [ADR-0020](0020-datasets-vivos.md) §5, con la lectura de los datasets desde el VPS (§4); y [ADR-0022](0022-modelo-de-estrategia.md) §8 y §11, con los importes y la paridad en Python (§3). No cambia [ADR-0016](0016-alojamiento-del-sistema-de-datos.md): el sistema de datos, la API y el motor `shadow` siguen en Render.

## Resumen para el propietario

- **Qué decide.** Cómo trabaja el motor que busca estrategias por ti: dónde corre, con qué tecnología, cómo prueba millones de ideas sin engañarse y cómo habla con buoh sin poder estropear nada.
- **Dónde.** En un VPS-2 de OVHcloud (4 núcleos y 8 GB), con Linux (Ubuntu 26.04 LTS), en Canadá, cerca de Render y de R2. Lo demás sigue en Render.
- **Cómo busca.** En Python acelerado con Numba, con las fichas de reglas de ADR-0022: primero al azar, después cruzando las mejores y al final afinándolas con Optuna. Cada búsqueda se anota en buoh antes de empezar, y la misma búsqueda corre también sobre datos al azar: si ahí «encuentra» estrategias, el motor no te propone nada.
- **Qué te llega.** Solo las pocas que pasan todo, de R_100 o del oro. buoh las vuelve a calcular con su propia calculadora y las prueba con datos que el motor nunca vio, y tú decides en la web. Cada semana ves un informe de lo que probó y de lo que no encontró.
- **Seguridad.** El VPS solo lee los datos, escribe en su propio cajón de R2, que nadie puede reescribir, y entra en buoh con una llave que solo registra búsquedas y solo vale desde el VPS. La creas y la anulas tú con una orden. Al VPS solo entras tú, con una llave SSH, y el cortafuegos cierra lo demás.
- **Mantenimiento.** Lo preparas una vez con los pasos del runbook, en una hora más o menos, con mi ayuda. Después se actualiza solo: el sistema, cada noche, y el motor, cuando fusionas un PR con CI en verde. Si se rompe, se reinstala con los mismos pasos sin perder nada.
- **Costo y riesgo.** El VPS, 10 USD al mes (unos R$ 59 a 63 con el IOF), y lo que lee y guarda en R2, hasta unos 0,50 USD: el total de buoh pasa de unos 54 a unos 56,50 USD al mes. Los 2 USD más del VPS los aceptaste al elegir OVHcloud; lo de R2 lo apruebas al fusionarla. Si el motor resulta lento, te pediré el VPS-3, de 4,50 USD más. Las listas de las búsquedas que no dejan nada que proponer se borran después de 30 días, y su resumen queda siempre. Si alguien tomara el VPS, podría llevarse los datos de mercado de buoh y dejar propuestas falsas, que buoh descubre al recalcularlas. Nada de esto opera ni toca dinero.
- **Qué apruebas al fusionarla.** Todo lo de arriba y las propuestas de la dirección técnica, entre ellas la llave del motor, la actualización sola y el orden de siete PR de §14.

## Contexto

El 2026-11-16 el propietario decidió que las estrategias las busque un motor de investigación en Python, en un VPS propio, que pruebe millones de estrategias de reglas; que el VPS lo administre él, con la ayuda del agente, y que solo él tenga acceso (`PROJECT_STATUS.md`, «Motor de investigación» y «Disco, VPS y reanudación»). Ese mismo día eligió el VPS y el sistema:

- «Ok me parece bien ese vps de contabo solo dime cuando es el costo real mensual o si existen mejores propuestas de vps en esa faixa de valor». El agente le comparó los precios reales, con el IOF de la tarjeta: el VPS-2 de OVHcloud, unos 10 USD al mes (unos R$ 59 a 63), su recomendación; el Cloud VPS 4 de Contabo, unos R$ 36 a 38, cuya CPU rinde menos con mucha carga; el CX33 de Hetzner, sin existencias; y Netcup, fuera de ese precio.
- «Elijo el de ovh, hay posibilidad de colocar todo el proyecto en la vps y no pagar render?». El agente le explicó que se puede, y que ahorraría unos 20 a 25 USD al mes, pero le recomendó seguir en Render hasta terminar la Fase 2: la base de datos, sus copias, la seguridad y las actualizaciones pasarían a ser trabajo suyo, y mudarse costaría semanas y volver a medir todo.
- «Ok seguimos en render vamos con el adr del motor pero antes de construirlo dame un resumen de lo que colocarás, como comportamiento, lenguajes usados (usa los mejores para ellos) tipos de tecnologías y como funcionaria». El agente le dio ese resumen, que esta ADR fija.
- «Ok pero el vps será linux o Windows? O como cual es el mejor?». El agente le recomendó Linux, Ubuntu 26.04 LTS: sin licencia, con menos memoria para el sistema, con las herramientas del motor nativas y con las actualizaciones de seguridad automáticas. El propietario respondió: «Ok escribe la adr del motor perfecto».

El plan pide esta ADR antes del código de F2.6b (§8, punto 10). `F2-RESEARCH-001` le pide la versión de Python, sus bibliotecas con su versión y su motivo, la gramática que recorre la búsqueda, los métodos de búsqueda, el registro de cada búsqueda y la seguridad del VPS, y que elija cómo se leen los datasets diciendo lo que filtraría un VPS comprometido. `F2-SEARCH-001` le pide justificar y fijar la credencial con la que el VPS registra en la API sus búsquedas y sus congelaciones, una entrada nueva desde internet que ADR-0019 no tiene, y añadir ese autor a ADR-0019 §5. `F2-API-001` le pide precisar en ADR-0019 §12 dónde corren los backtests.

Hechos comprobados el 2026-11-16:

- **Python.** La 3.14 va por la 3.14.10, con soporte hasta octubre de 2030; la 3.15 salió el 2026-10-09 y va por la 3.15.2. NumPy 2.5.5, Numba 0.68.1 y las demás bibliotecas de §2, con sus dependencias, tienen paquetes ya construidos (*wheels*) para la 3.14 en Linux x86-64.
- **Ubuntu 26.04 LTS** tiene soporte hasta abril de 2031.
- **OVHcloud**, en su sitio y en su catálogo público para Latinoamérica: el VPS-2 tiene 4 vCores, 8 GB de memoria y 75 GB NVMe, con copia diaria y tráfico ilimitado, y cuesta 10 USD al mes sin compromiso, 9,50 con 6 meses y 8,50 con 12, sin costo de instalación; el VPS-3, con 6 vCores, 12 GB y 100 GB, 14,50 sin compromiso y 12,32 con 12 meses. Los vende en Beauharnois, Alemania, Milán, Roubaix, Gravelines, Estrasburgo, Singapur, Sídney, el Reino Unido, Varsovia y Bombay, con Ubuntu 26.04 entre sus imágenes; su datacenter de Vint Hill, en Virginia, solo lo vende OVHcloud US. Subir de plan se hace en el panel, sin migrar, dentro del mismo datacenter y si hay recursos. Las existencias van y vienen: el 2026-11-08 un cliente no podía pedir ningún VPS de esa gama en los sitios de Francia e Italia, y a las 23:20 UTC del 2026-11-16 un seguimiento no oficial daba el VPS-2 con Linux agotado en todos los datacenters, con existencias por última vez en Beauharnois a las 22:28 y en Gravelines a las 23:02.
- **El repositorio es público**, y `main` no tiene protección de rama. Los commits de `main` llevan las comprobaciones de CI `verify:pr` y `test:integration` (y la del escritorio cuando cambian sus archivos), que la API de GitHub da sin credencial.
- **R2** limita cada token a unos buckets, no a un prefijo (ADR-0020 §5), con uno de cuatro permisos, y admite reglas de bloqueo y de ciclo de vida por prefijo.
- **Los datasets** viven en `buoh-captura`, bajo `datasets/`, y cuáles están publicados y verificados lo dice `buoh_datasets` (ADR-0020 §5 y §8), que la API lee con `buoh_api_lectura`.

## Decisión

### 1. Qué hace el motor

El motor de investigación es un servicio de `research/python` que corre sin parar en el VPS. Nunca opera: no se conecta con Deriv ni con ningún bróker, y no tiene ninguna credencial que escriba en la captura, en los datasets ni en la base (`F2-RESEARCH-001`). Su ciclo:

1. **Agenda.** Un archivo versionado de `research/python` dice qué estudiar: el mercado y sus datos (`ticks` de R_100 o del oro, o `deriv_candles` de los siete mercados de ADR-0021), la temporalidad, el tipo de contrato, la parte de la gramática de ADR-0022 que se recorre y el presupuesto de cada etapa. El motor la recorre en orden, sin parar, y vuelve a empezar cuando hay datos nuevos. Puede repartir el presupuesto entre entradas según lo que vio en las ventanas de entrenamiento, nunca según las de validación. Cambiar la agenda es un PR.
2. **Estudio.** Antes de buscar en un mercado, mide en la ventana de entrenamiento sus patrones descriptivos: la autocorrelación de los retornos, la volatilidad por hora y por día de la semana, los regímenes de volatilidad y la relación con los otros mercados. Van al informe semanal (§10). No son propuestas ni evidencia, y lo que cambien de la agenda llega en un PR.
3. **Registro.** Registra la búsqueda en la API y espera su respuesta antes de evaluar nada (§6). Sin respuesta, espera.
4. **Búsqueda.** Recorre la gramática en tres etapas, con el evaluador acelerado (§3), sobre la serie del mercado y sobre sus controles (§6).
5. **Resumen.** Deja la lista de todas las candidatas en `buoh-investigacion` (§7) y registra el resumen en la API.
6. **Repetición y congelación**, desde F2.7 y F2.8. Las finalistas se repiten con `packages/strategy-sdk`, en `apps/backtest`, en el mismo VPS, y la API registra la congelación de las que pasan (§6). En la API solo corren la réplica de cada versión congelada y su prueba fuera de muestra, en el proceso hijo de ADR-0019 §12, que ya no corre los backtests de la búsqueda (`F2-API-001`).
7. **Informes.** Cada hora deja su estado, y cada semana un informe (§10).

Si el VPS se apaga, no se para nada más: la captura, la API y el motor `shadow` no dependen de él (`F2-SHADOW-001`).

### 2. Python y sus bibliotecas

- **Python 3.14**, con la misma versión de parche en CI y en el VPS, que fija `research/python/.python-version` y que instala `uv` (hoy, la 3.14.10). Es la versión más nueva con un año de arreglos, y todas las bibliotecas de abajo la soportan. La 3.15 salió hace un mes: pasar a ella es un PR propio, cuando sus bibliotecas lleven unos meses con ella. Una versión de parche con arreglos de seguridad entra con un PR.
- **Bibliotecas de ejecución**, con la versión más nueva del 2026-11-16; cada PR instala la más nueva que cumpla la regla de los 7 días de abajo:

| Biblioteca | Versión | Para qué | Por qué |
|---|---|---|---|
| `numpy` | 2.5.5 | las series en memoria y la caché de los datos | la base del cálculo numérico en Python, y lo que compila Numba |
| `numba`, con `llvmlite` | 0.68.1 y 0.50.0 | compilar a código máquina los indicadores, el evaluador y las posiciones | da la velocidad de un lenguaje compilado sin salir de Python; sin `fastmath`, respeta las reglas de IEEE 754 que pide la paridad (ADR-0022 §8) |
| `optuna` | 5.1.0 | los muestreadores TPE y NSGA-II de la tercera etapa (§6) | maduro y con semilla, y su interfaz de pedir y responder (*ask and tell*) deja evaluar en los procesos del motor, en un orden fijo. Trae SQLAlchemy, Alembic, PyYAML, tqdm y colorlog, aunque el motor guarda sus estudios en memoria |
| `boto3` | 1.44.4 | leer y escribir en R2 | el cliente de S3 de referencia, el que documenta Cloudflare para R2 |
| `urllib3` | 2.8.0 | las peticiones a la API | ya llega con `boto3`, verifica TLS por defecto y tiene plazos, así que no suma otra biblioteca |
| `jsonschema` | 4.26.0 | validar con el JSON Schema 2020-12 que genera `packages/contracts` | Python valida los contratos y no inventa formatos (ADR-0003, «Contrato entre lenguajes») |
| `rfc8785` | 0.1.4 | el JSON canónico (JCS) que da la identidad de cada candidata (ADR-0022 §9) | de Trail of Bits, sin dependencias, con el formato de números de ECMAScript, el mismo de TypeScript |

- **Herramientas**: `uv` 0.13.8, que instala Python y el entorno con el archivo de bloqueo y el hash de cada paquete, en CI y en el VPS, donde se instala en su versión fijada, con su hash comprobado; `pytest` 9.2.0, para las pruebas, en CI y en el VPS, en un grupo de dependencias aparte que solo se instala en el entorno de las pruebas (§9); y, solo para desarrollar y en CI, `ruff` 0.17.5, el linter y el formato, y `mypy` 2.4.1, en modo estricto.
- **Reglas.** `research/python` es un proyecto virtual (`[tool.uv] package = false`, sin `[build-system]`): uv no lo construye, y el motor corre su código desde la copia de su versión. `uv.lock` fija cada dependencia con su hash, y el VPS la instala con `uv sync --locked --no-build --no-dev`: solo paquetes ya construidos, sin ejecutar el código de instalación de ninguno ni descargar nada sin fijar. Una prueba de CI falla si esa orden construye algo. Una biblioteca o una versión nueva entra en el PR que la usa, publicada hace al menos 7 días salvo un arreglo de seguridad, y su motivo va a ADR-0003.
- **Lo que no entra:** pandas ni Polars, porque bastan NumPy y lectores propios, y el plan difiere un writer Parquet (plan §6; §7); SciPy, porque la estadística del motor cabe en NumPy y en `statistics`, y la ADR del protocolo estadístico lo suma si hace falta; el aprendizaje automático, que llega después de la puerta de salida (plan §6); Ray o Dask, que no hacen falta en una sola máquina; y Rust o C++, solo con una medición que lo pida (ADR-0003).

### 3. El evaluador acelerado y la paridad

- **Las mismas reglas.** Python implementa con Numba la biblioteca de indicadores 1.0.0, las reglas, los contratos, la caída máxima y la política de datos de ADR-0022: sin `fastmath`, sin reducciones en paralelo y con cada suma en el orden de su definición (ADR-0022 §8). Los decimales canónicos pasan a binario64 con `float()`, que redondea al más cercano, como `Number()` en TypeScript.
- **Importes** (precisión de ADR-0022 §8, solo para Python). El cálculo rápido va en binario64. Cuando un resultado queda a menos de 0,000001 USD de un umbral (el stop loss, el take profit, perder la apuesta o la caída máxima) o, al liquidar una posición, de un medio centavo, se repite con los enteros de punto fijo de ADR-0022 §5, que deciden. Esos enteros no caben en los 64 bits de Numba, así que ese cálculo va fuera de él, con los enteros de Python. El error del binario64 en esas operaciones queda muchos órdenes por debajo de ese margen, así que fuera de él los dos cálculos deciden igual; el PR 2 calcula esa cota. Las decisiones y los resultados salen iguales que en TypeScript, y los vectores compartidos tienen casos en el borde de cada umbral.
- **Los mismos resultados.** Los vectores de `test-vectors/` de ADR-0022 §11 pasan en CI en los dos lados, y en el VPS antes de usar cada versión (§9). La identidad de cada candidata es el SHA-256 de su JCS, como en TypeScript.
- **Velocidad.** Cada serie de un indicador se calcula una vez por serie de la búsqueda (su secuencia y su período), temporalidad y parámetros, recorriendo sus datasets en orden y con el arranque que fije la ADR de la semántica del backtest, y la reutilizan todas las candidatas que la usan, dentro de un tope de memoria. Las series de cada dataset se guardan como arrays de NumPy que los procesos del motor abren en modo de solo lectura, compartidos por el sistema, sin copiarlos. Hay un proceso de evaluación por vCore.
- **Costos y caída máxima.** Cada candidata paga los costos de su tipo de contrato (ADR-0022 §5) y se detiene con la caída máxima del 50 % o con su tope menor (`F2-RESEARCH-001`).
- **No es evidencia.** Nada de lo que calcula el motor cuenta como evidencia (plan §4.1 y §4.7): las finalistas se repiten con `packages/strategy-sdk` (F2.7), y la API repite su backtest antes de `shadow` (F2.8).

### 4. Los datos

- **Qué datasets.** La API le da, con la credencial del motor (§5), los datasets de `production` publicados y verificados en los dos modos (ADR-0020 §8), por secuencia y por período: su `dataset_id`, la clave de su manifiesto y el SHA-256 del manifiesto. Los toma de `buoh_datasets`, con `buoh_api_lectura` (ADR-0020 §5).
- **Cómo los lee.** De `buoh-captura`, con el token `motor-lectura`, de solo lectura (§7). Compara el SHA-256 de cada manifiesto con el de la API, y el de cada objeto con el del manifiesto, antes de usarlos. Lee por partes, con un techo de memoria (`F2-RESEARCH-001`). Un hash que no coincide deja fuera ese dataset y queda en el estado (§10).
- **La caché.** Las series ya verificadas quedan en el disco del VPS como arrays de NumPy, por el hash de su objeto. Se puede borrar cuando sea: se vuelve a construir desde R2.
- **Qué usa.** Los ticks de la captura y de la historia de R_100 y del oro, las velas de Deriv de los siete mercados, las cotizaciones y los horarios (ADR-0021 §3 y §4).
- **Qué filtraría un VPS comprometido**, con cada opción del plan:

| Opción | Qué filtraría | Decisión |
|---|---|---|
| La lista de la API y un token de solo lectura de `buoh-captura` | todo `buoh-captura`: los datasets y los logs de 30 días, que son datos de mercado de Deriv sin secretos. Un dataset lleva su propia copia de los segmentos de su log (ADR-0020 §5), así que de más solo filtraría las horas todavía sin publicar | elegida |
| Un rol de PostgreSQL que solo lee `buoh_datasets` | lo mismo en R2, y además una contraseña de la base, que está abierta a internet (ADR-0018 §9) y comparte sus 0,1 CPU con la captura y la API | descartada |
| Una copia de los datasets en otro bucket, escrita por el plano de datos | solo los datasets, pero duplica unos 4 GB y suma un proceso y un token al plano de datos | descartada |

  Los términos de Deriv solo permiten guardar sus datos 24 horas, y el propietario aceptó guardarlos para su uso (ADR-0021 §7). Si se filtraran, saldrían de buoh: es el riesgo que acepta esta elección.

### 5. La credencial del motor

**Por qué una entrada nueva.** `F2-SEARCH-001` pide que la API valide y guarde cada búsqueda y cada congelación antes de que el motor siga. Si la API recogiera de R2 lo que deja el motor, el motor solo sabría que la API lo registró preguntándoselo, también con una credencial. ADR-0019 descartó otra puerta en internet para crear cuentas. Esta no crea cuentas ni abre sesiones, no aprueba nada y solo vale desde el VPS.

- **Alta y baja.** El propietario la crea con `cuenta motor crear <usuario>` y la anula con `cuenta motor revocar <usuario>`, en la consola de `buoh-api` en Render, como el resto de la orden `cuenta` (ADR-0019 §3). Crear una nueva anula la anterior: una cuenta tiene como mucho una. La orden escribe el token una sola vez en stdout, y el propietario lo pega en el VPS (§8). Nunca pasa por el chat, por Git ni por los registros.
- **El token.** 32 bytes aleatorios en base64url, con el prefijo `buoh_motor_` para reconocerlo si aparece donde no debe. El servidor guarda solo su HMAC-SHA-256 con `BUOH_API_TOKEN_KEY` y la etiqueta `buoh/motor/v1`, como las sesiones (ADR-0019 §2): con la contraseña del rol de la API no se puede fabricar uno. No vence: se cambia al reconstruir el VPS o ante una sospecha. Cambiar `BUOH_API_TOKEN_KEY` también lo anula.
- **Uso.** Va en `Authorization: Bearer`, solo en las rutas `/api/v1/investigacion/`. Esas rutas no aceptan la cookie de sesión, y las demás no aceptan el token. No necesitan las condiciones de CSRF, porque un navegador nunca envía este token por su cuenta, pero rechazan una petición con `Origin`, que solo pone un navegador. La línea de cada petición no lo lleva, porque sus campos son de una lista cerrada (ADR-0019 §11).
- **Solo desde el VPS.** La API compara la dirección del cliente, la de `CF-Connecting-IP` (ADR-0019 §1), con las de `BUOH_API_MOTOR_IPS`: la IPv4 y la IPv6 del VPS, que pega el propietario en Render (`sync: false`, para no publicarlas en el repositorio). Sin esa variable, en `production` el token no vale. Un token válido desde otra dirección se rechaza y queda en la auditoría, que ve el propietario: es la señal de que se filtró y hay que anularlo.
- **Límites.** 60 peticiones por minuto, 20 búsquedas registradas al día, 20 congelaciones a la semana y cuerpos de 64 KiB como mucho. Con un token que no existe, cada fallo cuenta en el límite por dirección de ADR-0019 §1. Un rechazo de la credencial responde `unauthenticated`, sin decir por qué, y las demás respuestas usan los códigos de ADR-0019 §6.
- **Lo que puede hacer**, siempre con la cuenta de la credencial (ADR-0019 §4):

| Ruta | Qué hace |
|---|---|
| `GET /api/v1/investigacion/datasets` | da los períodos que cubren los datasets publicados y verificados de cada secuencia (§4) |
| `POST /api/v1/investigacion/busquedas` | registra una búsqueda (§6) y devuelve sus datasets |
| `GET /api/v1/investigacion/busquedas/{id}` | devuelve una búsqueda registrada, para seguir tras un reinicio |
| `POST /api/v1/investigacion/busquedas/{id}/resumen` | registra el resumen de una búsqueda (§6) |
| `POST /api/v1/investigacion/congelaciones` | registra la congelación de una candidata (§6); llega con F2.8 |

  No lee sesiones, cuentas, la auditoría ni otros objetos de la cuenta, y no aprueba, promueve ni retira nada.
- **Las tablas**, en el esquema `buoh_api`, append-only como las demás (ADR-0019 §7): las credenciales y sus revocaciones, los conjuntos de datasets, las búsquedas y sus resúmenes, y desde F2.8 las congelaciones.
- **La auditoría** (precisión de ADR-0019 §5). El autor nuevo es el motor de investigación (`research_engine`), y las acciones nuevas son estas:

| Acción | Autor | Motivos | Objetos |
|---|---|---|---|
| `research_credential_created` | el operador | `created`, o `replaced` si anula otra | la cuenta, la credencial y la anulada |
| `research_credential_revoked` | el operador | `revoked` | la cuenta y la credencial |
| `research_search_registered` | el motor | `registered` | la cuenta, la búsqueda, y su especificación y sus conjuntos de datasets, por su hash |
| `research_search_summarized` | el motor | `completed` o `interrupted` | la cuenta, la búsqueda y su resumen, por su hash |
| `research_candidate_frozen` | el motor | `frozen` o `demonstration` | la cuenta, la búsqueda, la congelación y la versión de la estrategia, por su hash |
| `research_requests_rejected`, agrupadas cada 5 minutos como `login_failures` | anónimo, como `login_failures` | `address_not_allowed`, `rate_limited`, `limit_reached`, `revoked_credential` o `unknown_credential` | la cuenta y la credencial, si el token existe |

  Un token revocado cuenta como uno que existe, para que el propietario vea quién lo sigue usando. Con un token que existe, `research_requests_rejected` lleva su cuenta; sin él, es, como `login_failures`, una entrada que ninguna cuenta ve (ADR-0019 §4). El contrato suma las clases de objeto de la investigación. `research_candidate_frozen` llega con la congelación, en F2.8.
- **Datos no confiables.** Lo que escribe el VPS se trata como dato no confiable: los contratos de la investigación solo admiten códigos de listas cerradas, números, fechas UTC y hashes, el texto libre de una definición (ADR-0022 §1) tiene un tope, y la web lo muestra como texto (ADR-0019 §9).

### 6. La búsqueda honesta

- **La especificación** (`ResearchSearchSpec` 1.0.0). Antes de mirar ningún resultado, la búsqueda registra lo que puede probar (protocolo §1): la gramática de `StrategyDefinition` 1.0.0 y la biblioteca de indicadores 1.0.0 de ADR-0022, y la parte que recorre, con sus indicadores, sus operadores, sus tipos de contrato y el rango de cada parámetro; cada serie, por su secuencia y su período; las ventanas de entrenamiento y de validación, en UTC, en orden y sin solaparse; la métrica principal, de la lista que fije la ADR del protocolo estadístico; los métodos, con el presupuesto de cada etapa; la semilla; los controles; los costos, con su supuesto antes de las cotizaciones (ADR-0022 §5); y las versiones del motor y del evaluador. Cambiar cualquier cosa es otra búsqueda.
- **Lo que comprueba la API.** El contrato; que datasets publicados y verificados cubren cada período, y los guarda una sola vez, como un conjunto con su hash, que devuelve al motor; que las ventanas están en orden y dentro de sus datos; y los límites de §5. Guarda la especificación append-only con su hash JCS, su hora y su entrada de auditoría.
- **Tres etapas**, con el presupuesto registrado y siempre en la ventana de entrenamiento:
  1. al azar, uniforme sobre la gramática, que cubre el espacio y da la distribución de la métrica entre estrategias sin ninguna intención;
  2. evolutiva: selección por torneo, cruce de grupos de condiciones y mutación de parámetros y operadores;
  3. afinado de las mejores estructuras con Optuna: TPE con una métrica, y NSGA-II con varias, como la métrica principal y la caída máxima.

  Las finalistas se miden una vez en la ventana de validación, y cada medición cuenta como una prueba. La prueba fuera de muestra nunca la ve el motor: usa datos posteriores a la congelación (`F2-EVAL-001`). Cada búsqueda cuenta en la familia de las de su mercado y sus ventanas, y la ADR del protocolo estadístico fija cómo se suman las pruebas de toda la familia.
- **Determinista.** El azar sale de la semilla registrada, con un `Generator` de NumPy (PCG64) y los muestreadores de Optuna con semilla, y los resultados se reúnen por el número de cada candidata, no por el orden en que terminan los procesos. El tamaño de cada lote que se pide a Optuna y el de cada generación los fija la especificación, no el número de procesos, y el punto de control guarda el estado de los muestreadores. Con la misma especificación, los mismos datos y la misma versión, la lista sale igual, byte a byte, con uno o con cuatro procesos, y una búsqueda interrumpida que sigue desde su punto de control da la misma lista que sin interrumpirse. Una candidata repetida no se vuelve a evaluar, y la lista la cuenta. Una búsqueda dura como mucho 48 horas: al llegar a ese tope termina como interrumpida, con su resumen.
- **Controles negativos.** La misma búsqueda, con el mismo presupuesto y la misma selección, corre también sobre una serie al azar, armada con los retornos del mercado barajados con la semilla registrada, que conserva su distribución y destruye su orden; y, en las búsquedas sobre `ticks` del oro, sobre los ticks de R_100, con sus costos y con los multiplicadores y las duraciones que acepta más cercanos a los de la búsqueda. La ADR del protocolo estadístico fija cuántas aprobadas en un control son demasiadas. Con más, el motor no propone nada, de ningún mercado, hasta que una versión nueva lo corrija, y el informe semanal lo dice (`F2-SEARCH-001`).
- **Las listas** (`ResearchCandidateList`). Una por serie, con todas las candidatas evaluadas, también las descartadas: su número, su genoma (las elecciones de la gramática que la definen), la etapa, y su métrica principal y su número de operaciones en entrenamiento y, si llegó, en validación. Van a `buoh-investigacion` (§7): las de las búsquedas con finalistas que se pueden congelar, para siempre, y las demás, 30 días (precisión de `F2-SEARCH-001`). PostgreSQL guarda la especificación, el resumen con el hash del manifiesto de cada lista y cada congelación, y el resumen queda para siempre, con sus recuentos y lo que pida la ADR del protocolo estadístico para la familia.
- **El resumen** (`ResearchSearchSummary`): cuántas candidatas se probaron en cada etapa y serie, cuántas pasaron cada filtro, cuántas veces se miró la validación, el resultado de los controles, las finalistas con la huella de su definición, el hash de cada lista, la duración y el entorno (las versiones de Python, de las bibliotecas y del motor, y la CPU), este fuera de la comparación, como en `F2-BACKTEST-001`. La API comprueba que cada manifiesto está en `buoh-investigacion`, con su hash, y que existen sus partes. La ADR del protocolo estadístico suma lo que necesiten sus correcciones.
- **La congelación** (`ResearchCandidateFreeze`). Solo para estrategias sobre `ticks` de R_100 o del oro (ADR-0022 §2), después de su repetición en `apps/backtest` (F2.7) y de las correcciones de la ADR del protocolo estadístico. La API comprueba que la búsqueda tiene su resumen y que la candidata es una de sus finalistas, con la misma huella; registra la definición como `draft` (ADR-0022 §10), con su origen; guarda la hora de la congelación, de la que parte la ventana fuera de muestra (`F2-EVAL-001`); y deja su entrada de auditoría. Cada candidata congelada empieza su propia familia: su `strategy_id` sale de su búsqueda y de su número, su versión semántica es la 1.0.0 y su responsable es la cuenta de la credencial (ADR-0022 §1 y §9). Repetir la misma congelación devuelve la ya registrada, sin otra entrada. La ruta, su contrato, su tabla y su acción llegan con F2.8, con los campos que sumen las ADR de la semántica del backtest y del protocolo estadístico, y no antes: en F2.6b, la API no acepta congelaciones (precisión del plan §9). La candidata de demostración de `F2-SEARCH-001` se congela igual, con su marca, solo si en su búsqueda no pasó ninguna. De las estrategias sobre `deriv_candles` y de los mercados que no se capturan en vivo, el motor informa lo que encuentra y no congela nada.

### 7. El bucket `buoh-investigacion`

- Lo crea el propietario, con la indicación de ubicación `enam`, como `buoh-captura` (ADR-0018 §1). Tiene tres prefijos, cada uno con su regla de bloqueo, para que lo escrito no se reescriba ni se borre (`F2-SEARCH-001`), y los dos últimos, con una regla de ciclo de vida que borra lo que vence:

| Prefijo | Qué guarda | Bloqueo | Se borra |
|---|---|---|---|
| `permanente/` | las copias de las listas de las búsquedas con finalistas que se pueden congelar, los resultados de los backtests de F2.7 y los informes semanales | indefinido | nunca; se revisa con el propietario cuando el bucket pasa de 20 GB |
| `temporal/` | las partes de las listas de todas las búsquedas, a medida que se escriben | 30 días | a los 31 días |
| `estado/` | el estado de cada hora, los puntos de control y los diagnósticos | 7 días | a los 8 días |

- **Objetos.** Cada uno se nombra con su SHA-256 y se escribe con `If-None-Match: *`; un 409 de la regla de bloqueo cuenta como que ya existe (precisión de ADR-0018 §10). Una lista son partes de NDJSON en gzip, de como mucho 50 000 filas, que se escriben en `temporal/` a medida que se completan, con un manifiesto que da el SHA-256 y las filas de cada parte. Si la búsqueda tiene finalistas que se pueden congelar, sus partes se copian a `permanente/` dentro de R2 antes del resumen. Un punto de control guarda solo el estado de la búsqueda y las partes ya escritas.
- **Por qué NDJSON en gzip.** La API lo lee con `node:zlib`, como los datasets (ADR-0020 §7), sin una biblioteca de Parquet, y el plan difiere un writer Parquet (plan §6).
- **La API** lee de ahí con su token de solo lectura, con un techo por objeto (1 MiB para un estado, un informe o un manifiesto; 16 MiB para una parte, que lee línea a línea, con 64 MiB al descomprimirla, con `maxOutputLength` de `node:zlib`, y 64 KiB por línea antes de `JSON.parse`), y valida con los contratos y los hashes todo lo que lee (`F2-SEARCH-001`): el nombre de cada objeto tiene que ser el hash de su contenido, y lo que pasa de su techo se rechaza. La ADR de la semántica del backtest fija el techo de los resultados de F2.7.
- **Tokens nuevos** (complementa ADR-0018 §10), que crea el propietario, sin vencimiento, como los demás:

| Token | Permiso | Bucket | Lo usa |
|---|---|---|---|
| `motor-lectura` | Object Read only | `buoh-captura` | el motor, en el VPS |
| `motor-investigacion` | Object Read & Write | `buoh-investigacion` | el motor, en el VPS |
| `api-investigacion` | Object Read only | `buoh-investigacion` | `buoh-api`: lo que lee de ahí, con sus techos |
| `agente-investigacion` | Object Read only | `buoh-investigacion` | el agente, que así ve el estado, los diagnósticos y los informes sin entrar en el VPS |

  La API recibe el suyo en dos variables nuevas de `buoh-api` en `render-datos.yaml`, con `sync: false`, y el agente, en dos secretos nuevos de Kiro (ADR-0018 §12). El PR 5 comprueba si el filtro por direcciones de los tokens de Cloudflare vale para R2; si vale, los dos tokens del VPS solo funcionan desde sus direcciones.
- **Un token del VPS filtrado** puede leer `buoh-captura` (§4) y escribir en `buoh-investigacion`, pero no reescribir ni borrar lo que ya existe. Sí podría llenarlo de objetos que se cobran: el propietario pone en Cloudflare una alerta de presupuesto (*budget alert*) un poco por encima del gasto normal de la cuenta, por ejemplo de 25 USD al mes, que avisa por correo sin parar nada.

### 8. El VPS

- **Plan y región.** El VPS-2 de OVHcloud, en un datacenter y no en una *Local Zone*, pagado mes a mes hasta que la medición de §11 confirme que basta; después, el propietario puede pasar al compromiso de 12 meses, que se paga por adelantado (102 USD, más el IOF) y sale 1,50 USD más barato al mes. En Beauharnois (Canadá): de los datacenters que vende el sitio para Latinoamérica, el más cercano a Render en Virginia y a R2 en el este de Norteamérica, y más cercano a Brasil que los de Europa. Si no hay existencias, en Gravelines (Francia). Si en una semana no hay en ninguno de los dos, el agente le presenta al propietario las opciones, entre ellas el Cloud VPS 4 de Contabo, el plan B, con su precio de ese día.
- **Sistema.** Ubuntu 26.04 LTS, con soporte hasta abril de 2031.
- **Acceso.** Solo el propietario, con una llave SSH Ed25519 con frase de paso, desde su PC, con el cliente SSH que trae Windows (plan §4, punto 10). Sin contraseñas ni `root` por SSH. La cuenta de OVHcloud, que puede reinstalar el VPS y abrir su consola, tiene la verificación en dos pasos, como las de Render y GitHub (ADR-0019 §3). El agente no recibe ningún acceso.
- **Red.** El cortafuegos (`ufw`) solo deja entrar SSH, y en el VPS no escucha ningún otro servicio. OVHcloud incluye la protección contra DDoS. La salida no se limita en el cortafuegos, porque GitHub, PyPI, R2 y Render cambian de dirección; el cliente HTTP del motor solo conecta con el origen de la API y el endpoint de R2 de su configuración.
- **Actualizaciones del sistema.** `unattended-upgrades` instala las de seguridad de Ubuntu cada noche y reinicia a las 04:00 UTC si hace falta. El motor sigue desde su último punto de control.
- **Los servicios**, de systemd:
  - `buoh-motor`: con su propio usuario, sin inicio de sesión; con prioridad baja (`Nice=10`), para que SSH y la actualización respondan; `MemoryMax=6G`; reinicios con una espera que crece de 30 s a 1 hora (`RestartSteps` y `RestartMaxDelaySec`); sus credenciales con `LoadCredentialEncrypted`, cifradas con `systemd-creds` (con el TPM del VPS si lo tiene, y si no, con la clave del sistema, que solo lee `root`); y el aislamiento de systemd: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, la protección del kernel y de los cgroups, `RestrictAddressFamilies`, `SystemCallFilter=@system-service`, ninguna capacidad y `UMask=0077`. No lleva `MemoryDenyWriteExecute`, que impide compilar a Numba.
  - `buoh-motor-actualizar`: cada 15 minutos (§9), con otro usuario y sin ninguna credencial de buoh.
  - `buoh-motor-diagnostico`: lo arranca el propietario cuando el agente se lo pide, y deja en `estado/` un informe con campos de una lista cerrada (las versiones, el estado de los servicios, el disco, la memoria, la última actualización y los últimos errores por su código), nunca variables del entorno, líneas de comandos, credenciales ni direcciones.
- **Sin estado propio.** Lo que importa está en `buoh-investigacion` y en la API. En el disco solo quedan la caché, las versiones del motor y las credenciales. Reconstruir el VPS, o pasar a otro, es repetir los pasos, crear otra credencial del motor y cambiar `BUOH_API_MOTOR_IPS`; la búsqueda en curso sigue desde su punto de control.
- **La preparación.** `infra/vps-investigacion/` tiene el script que el propietario ejecuta una vez, desde un clon del repositorio, y las unidades de systemd. El script pide cada secreto en la terminal, sin mostrarlo ni pasarlo como argumento, y lo guarda cifrado con `systemd-creds`, en un archivo que solo lee `root`. Sin TPM, la clave del cifrado queda en el mismo disco: protege una copia suelta del archivo, no el disco entero. La copia diaria de OVHcloud guarda ese disco, y la protege, como al VPS, la cuenta de OVHcloud con su verificación en dos pasos. Repetir el script no rompe nada. El runbook del motor da los pasos, con lo que tarda cada uno: la primera vez, alrededor de una hora, con el agente.

### 9. Las actualizaciones del motor

El motor se actualiza solo desde `main`, en lugar de que el propietario instale cada versión con un comando, como proponía el plan (plan §14): así no se queda atrás ni le pide trabajo. Cada 15 minutos, `buoh-motor-actualizar`:

1. mira el último commit de `main`, por HTTPS;
2. solo sigue si el último commit de `main` desciende de la versión instalada por la cadena de primeros padres, si cada commit nuevo de esa cadena es el commit de fusión (`merge_commit_sha`) de un PR que fusionó el propietario (`merged_by`), según la API de GitHub, y si todas las comprobaciones de CI del último terminaron con éxito, también la nueva de `research/python` (`research:python`, en cada PR y en cada push a `main`, como `verify:pr`). El repositorio fusiona cada PR con un commit de fusión. Como `main` no tiene protección de rama, así no llega al VPS un commit subido sin PR, ni solo ni dentro de una fusión posterior, ni un commit de la rama de un PR, ni un `main` reescrito con un push forzado. Recuerda los commits ya comprobados, para no pasar de las 60 peticiones por hora que da GitHub sin credencial. Si un commit no pasa, el VPS sigue con su versión, lo dice en el estado y no vuelve a actualizarse solo: el propietario lo destraba con el script de §8, desde el commit que revise con el agente. Solo arma una versión nueva si cambian `research/python`, `test-vectors/` o los JSON Schema de `packages/contracts`;
3. arma la versión nueva aparte, con `uv sync --locked --no-build --no-dev`;
4. pasa las pruebas de `research/python`, también los vectores compartidos, en un entorno aparte con su grupo de pruebas, sin red (`PrivateNetwork=yes`) y en la CPU del VPS;
5. si pasan, la deja lista; si no, se queda con la que corre y lo dice en el estado.

El motor cambia de versión entre búsquedas, nunca en medio de una: cada búsqueda corre entera con una sola versión, también tras un reinicio, en el que sigue con la de su punto de control, y como dura como mucho 48 horas (§6), ninguna versión espera más. Se guardan la versión en uso, la de cada búsqueda con punto de control y las dos anteriores.

Quien puede fusionar en `main` decide el código del VPS, como ya decide el de Render, y la verificación en dos pasos de GitHub es la raíz de esa confianza (ADR-0019 §3). La API de GitHub identifica la cuenta, no a la persona: quien controle la cuenta del propietario, con su contraseña y su segundo factor o con un token suyo, fusiona como él. El agente usa otra identidad (`kiro-agent[bot]`), así que una fusión suya no llega al VPS. Una regla de rama que exija un PR en `main`, gratuita en un repositorio público, cerraría lo mismo también para Render; la decide el propietario aparte.

### 10. Estado, informes y la sección Laboratorio

- **Estado** (`ResearchEngineStatus`), cada hora en `estado/`: la versión, la búsqueda en curso y su avance, cuántas candidatas prueba por hora, el último punto de control, la última actualización y su resultado, el uso de disco y de memoria, y los errores por su código.
- **Informe semanal** (`ResearchWeeklyReport`), cada lunes a las 00:00 UTC en `permanente/`: las búsquedas de la semana, cuántas candidatas probó, los controles, los patrones del estudio, lo que propone, lo que encontró en los mercados que no se capturan en vivo y lo que no encontró (`F2-RESEARCH-001`). Un resultado negativo se muestra entero.
- **La sección Laboratorio** de la web muestra, con sesión, el estado del motor (en marcha, o sin noticias desde cuándo), las búsquedas con su especificación en palabras, sus controles y su resumen, y los informes semanales. La API los lee de PostgreSQL y de `buoh-investigacion` y los valida con sus contratos.
- **El agente** lee el estado, los diagnósticos y los informes con su token (§7). Así le llega la evidencia del VPS (plan §14).

### 11. Rendimiento y memoria

`F2-RESEARCH-001` pide medir cuántas estrategias prueba el motor por hora en el VPS y decidir con eso si el plan alcanza. Criterio, que mide el PR 7: en el VPS-2, una búsqueda de un millón de candidatas sobre un año del oro, en velas de 1 minuto armadas con sus ticks, con sus dos controles, termina en menos de 24 horas; la memoria anónima del servicio (`anon` en el `memory.stat` de su cgroup), sin la caché de páginas de los arrays, no pasa de 5 GiB, por debajo de `MemoryMax=6G`; y ningún proceso muere por memoria (`oom_kill` sigue en 0 en su `memory.events`). Si todavía no hay un año publicado, se mide con lo que haya y se escala. Si no se cumple, el agente le propone al propietario el VPS-3, 4,50 USD más al mes sin compromiso, que se sube en el panel sin migrar si hay recursos en el datacenter; si no, es un VPS nuevo con los mismos pasos (§8).

### 12. Costo

Estimaciones del 2026-11-16, que mide el PR 7:

- **El VPS-2**: 10 USD al mes pagando mes a mes, unos R$ 59 a 63 con el IOF del 3,5 % y el cambio de la tarjeta; 8,50 con el compromiso de 12 meses, pagados por adelantado (102 USD). Son unos 2 USD más que los unos 8 que el plan preveía para Contabo (plan §11).
- **R2**: unas 10 000 escrituras al mes (el estado, los puntos de control, las partes de las listas y los informes), que caben en los 3 millones de clase A que ya se cobran (ADR-0021 §6); menos de 0,1 millones de lecturas, que por el redondeo de R2 pueden sumar un millón de clase B, 0,36 USD; y de 3 a 9 GB de listas en `temporal/`, con unos 100 bytes por candidata y de 1 a 3 millones de candidatas al día, que R2 cobra a 0,015 USD por GB al mes por encima de 10 GB: como mucho unos 0,15 USD, y unos 0,30 cuando el bucket llegue a 20 GB, que es cuando se revisa con el propietario.
- **Render**: nada nuevo. La API sigue en su Starter, y lo que envía a R2 es poco.
- **Total**: unos 56,50 USD al mes: los unos 54 aprobados (plan §11), unos 2 más del VPS, que el propietario eligió conociendo su precio, y hasta unos 0,50 de lo que lee y guarda el motor en R2, que aprueba al fusionar esta ADR; con el bucket en 20 GB, unos 0,15 más.

### 13. Pruebas

- **`research/python`, sin red, sin reloj real y sin azar sin semilla**, con guardas propias en `conftest.py`, como las de TypeScript (`F1-VECTOR-001`):
  - los vectores compartidos de ADR-0022 §11, con los bordes de cada umbral y su cálculo exacto;
  - que cada candidata que genera la gramática valida con el JSON Schema de `StrategyDefinition` (`F2-RESEARCH-001`), con miles de genomas al azar y su semilla;
  - el JCS, con los vectores de RFC 8785 y las huellas de las definiciones de los vectores;
  - que la lista sale igual con uno y con cuatro procesos, al repetir la búsqueda y al seguirla desde un punto de control;
  - que un vector sintético sin patrón no deja pasar ninguna finalista, y uno con un patrón sembrado sí (`F2-SEARCH-001`), y la serie al azar de los controles, con su semilla;
  - que un hash que no coincide deja fuera su dataset;
  - que la configuración solo admite las tres credenciales del motor, que el cliente de `buoh-captura` no tiene métodos de escritura, y que el cliente HTTP rechaza un destino fuera de su configuración (`F2-RESEARCH-001`);
  - que la orden de instalación del VPS no construye nada (§2);
  - el actualizador, con una API de GitHub falsa: no cambia de versión sin todas las comprobaciones en éxito, con un commit de la cadena que no es de un PR fusionado por el propietario, también uno anterior a la última fusión, o con una prueba que falla.
- **La API**, sin red y con PostgreSQL local, como ADR-0019 §13: el HMAC del token, una credencial por cuenta y su revocación; la dirección del VPS con `CF-Connecting-IP` y su respaldo; que la cookie no vale en las rutas del motor ni el token en las demás; el rechazo de `Origin`; los límites; cada comprobación de la especificación, del resumen y de la congelación, también un período con datasets sin publicar; los techos de tamaño de §7, también un gzip que pasa del suyo al descomprimirlo; las tablas append-only (`42501`); que una credencial insertada con el rol de la API y el SHA-256 sin clave de un token elegido no vale; las entradas de auditoría; y el OpenAPI.
- **El VPS**: `shellcheck` sobre el script, `systemd-analyze verify` sobre las unidades y una prueba de que cada unidad lleva sus directivas de aislamiento.
- **En producción, fuera de CI** (PR 7): borrar una clave que no existe responde 403 con `agente-investigacion` en `buoh-investigacion`, desde el sandbox, y con `motor-lectura` en `buoh-captura`, desde el diagnóstico; con `motor-investigacion`, desde el diagnóstico, reescribir o borrar un objeto de `permanente/` responde 409; una petición con un token inventado responde `unauthenticated`; una captura del propietario muestra los permisos de los cuatro tokens; y el criterio de §11.

### 14. Secuencia de entrega

El código de F2.6b empieza cuando está fusionado lo que necesita de F2.5b y de F2.6 (plan §5 y §9), y después de las cinco ADR del laboratorio (plan §8). Siete PR:

1. Esta ADR, con sus precisiones al plan de Fase 2, a `PROJECT_STATUS.md`, a ADR-0003, a ADR-0019, a la arquitectura objetivo, a los contratos de dominio, a la visión de producto y al `README.md`.
2. **La base de `research/python`**, después del PR 3 de ADR-0022, que trae los vectores compartidos: `pyproject.toml`, `uv.lock` y `.python-version`; ruff, mypy estricto y pytest con sus guardas; el trabajo `research:python` en CI; la regla de `research/python/**` en el mapa de impacto, con esta ADR como fuente (`F2-GOV-001`); la validación con el JSON Schema de `packages/contracts` y el JCS; y los indicadores, el evaluador y las posiciones con Numba, con la paridad de §3.
3. **La API del motor**, después del PR 2 de ADR-0022, que trae `StrategyDefinition`: los contratos de §5, §6 y §10 en `packages/contracts`, salvo el de la congelación, que llega con F2.8 (§6), con su JSON Schema y su semántica en los contratos de dominio; la migración de sus tablas; `cuenta motor crear` y `cuenta motor revocar`; las rutas con su dirección, sus límites y sus comprobaciones; la auditoría; y el OpenAPI. En producción no hace nada mientras no exista `BUOH_API_MOTOR_IPS`.
4. **La búsqueda**: la agenda, el estudio, la lectura de los datos con sus hashes y la caché, las tres etapas, los controles, las listas, los puntos de control, el estado, el informe semanal y el cliente de la API, con las pruebas de §13. Mide en local cuántas candidatas prueba por hora, que todavía no es el criterio de §11.
5. **El VPS**: `infra/vps-investigacion/`, con el script, las unidades y el actualizador; el runbook del motor, con la compra, la preparación, el bucket y sus reglas, los cuatro tokens, la credencial del motor, la alerta de presupuesto, el diagnóstico, y cómo reconstruir, rotar y borrar; las variables de `buoh-api` en `render-datos.yaml`, con su prueba; y la regla de `infra/vps-investigacion/**` en el mapa de impacto. Como cambia `render-datos.yaml`, va fuera de la rotación de la credencial dueña, como los PR 3 y 5 de ADR-0021 (runbook de ingesta, «Rotar credenciales»). El propietario compra el VPS después de fusionarlo; conviene que la historia de ADR-0021 (su PR 6) ya se esté publicando, para que el motor tenga qué estudiar desde que se paga.
6. **La sección Laboratorio**: el estado del motor, las búsquedas y los informes, con sus rutas de sesión en la API.
7. **La evidencia**: las primeras búsquedas en producción, con sus controles; el criterio de §11; la memoria, el espacio y el costo medidos; las comprobaciones de §13; y un diagnóstico leído por el agente. Con ella, F2.6b está hecho.

### Relación con ADR anteriores

- **ADR-0003:** suma la sección de las bibliotecas del motor, con los motivos de §2.
- **ADR-0016:** el sistema de datos sigue en Render. El VPS vuelve solo para la investigación, sin poder escribir en la captura, en los datasets ni en la base (plan §14).
- **ADR-0018:** §10 suma `buoh-investigacion` y los cuatro tokens de §7, y §12, las dos variables de `buoh-api` y los dos secretos del agente.
- **ADR-0019:** §2 y §3 suman la credencial del motor y su orden; §4, sus objetos con la cuenta de la credencial; §5, su autor y sus acciones; §7, que `buoh_api_lectura` da también la lista de datasets del motor; §10, que cambiar `BUOH_API_TOKEN_KEY` anula también su credencial; y §12, que en el proceso hijo solo corren la réplica y la prueba fuera de muestra.
- **ADR-0020:** el VPS lee los datasets de `buoh-captura` con su propio token de solo lectura (§4).
- **ADR-0022:** Python implementa su gramática, su biblioteca y su evaluador con las mismas reglas, y sus vectores deciden. §8 suma, solo para Python, los importes en binario64 que se repiten en punto fijo cerca de un umbral (§3).

## Consecuencias

- El motor prueba millones de estrategias al día por unos 10 USD al mes, sin tocar la captura, la API ni el motor `shadow`.
- La API tiene una entrada nueva desde internet, limitada a la investigación y a las direcciones del VPS (§5).
- El propietario administra un servidor: lo prepara una vez, después se actualiza solo, y si se rompe se reconstruye sin perder nada. El agente no lo ve por dentro: depende del estado y de los diagnósticos.
- Quien fusiona en `main` decide el código del VPS, como el de Render.
- Un VPS comprometido filtraría los datos de `buoh-captura` y podría dejar búsquedas y congelaciones falsas, que la réplica de la API descubre antes de `shadow` (plan §14), u objetos que se cobran, de los que avisa la alerta de presupuesto. Los techos de §7 impiden que tumbe la API con un objeto enorme.
- Los recuentos de pruebas y el resultado de los controles solo los afirma el VPS: la API comprueba que las listas existen y sus hashes, no lo que dicen. La ADR del protocolo estadístico decide si los recalcula desde las listas; la réplica y la prueba fuera de muestra no dependen de ellos.
- Las listas de las búsquedas sin finalistas que se pueden congelar se borran después de 30 días; de ellas quedan sus resúmenes.
- Lo que propone el motor no es evidencia hasta que lo repiten `packages/strategy-sdk` y la API.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Que la API recoja de R2 lo que deja el motor | El plan pide que la API valide y registre antes de que el motor siga, y el motor tendría que preguntarle igual, con una credencial. |
| Un rol de PostgreSQL o una copia de los datasets para el VPS | §4. |
| El motor en Render | Ya el worker Standard de Render, con 2 GB, cuesta 25 USD al mes, frente a los 8 GB del VPS por unos 10. |
| Mover todo buoh al VPS | Ahorraría unos 20 a 25 USD al mes, pero la base, sus copias, la seguridad y las actualizaciones pasarían al propietario, y mudarse costaría semanas y volver a medir todo. Se revisa al terminar la Fase 2. |
| Windows | Pide licencia y más memoria para el sistema, y las herramientas del motor son nativas de Linux. |
| Docker en el VPS | Suma un servicio con permisos de `root` y otra cadena de imágenes; systemd aísla el motor con menos piezas. |
| Python 3.15 | Salió hace un mes. |
| Polars y Parquet | El plan difiere un writer Parquet, y la API necesitaría otra biblioteca para leerlo. |
| GPU, Ray o Dask | El VPS no tiene GPU, y una sola máquina no necesita un sistema distribuido. |
| Rust o C++ | Solo con una medición que lo pida (ADR-0003). |
| Que el propietario instale cada versión | Le da trabajo, y las versiones se quedan atrás. |
| Actualizar en medio de una búsqueda | La búsqueda mezclaría dos versiones del motor. |
| Guardar todas las listas para siempre | De 1 a 3 millones de candidatas al día son de 3 a 9 GB al mes que casi nunca se vuelven a leer, y sus resúmenes quedan. |
| Un token del motor que vence | Pararía el motor sin aviso; con la dirección del VPS, un token filtrado no sirve fuera de él. |
| `fail2ban` o cambiar el puerto de SSH | Con solo llaves, aportan poco. |
| El Cloud VPS 4 de Contabo | Más barato, pero su CPU rinde menos con mucha carga: queda como plan B. El CX33 de Hetzner no tenía existencias, y Netcup no entraba en el precio. |
| Acceso del agente al VPS | El propietario decidió que solo él tenga acceso (plan §12). |

## Condiciones de revisión

- El motor no cumple el criterio de §11.
- `buoh-investigacion` pasa de 20 GB.
- OVHcloud cambia el plan o su precio, o el VPS se ve comprometido.
- Render deja de pasar `CF-Connecting-IP`, y la credencial del motor deja de valer.
- Una biblioteca de §2 deja de mantenerse, o tiene un fallo de seguridad sin arreglo.
- Llega la inteligencia artificial, después de la puerta de salida, con su ADR.
- Al terminar la Fase 2, si conviene mover más servicios a un VPS.

## Referencias verificadas

Consultadas el 2026-11-16:

- PyPI: `numpy`, `numba`, `llvmlite`, `optuna`, `boto3`, `urllib3`, `jsonschema`, `rfc8785`, `uv`, `ruff`, `mypy` y `pytest`, con sus versiones, sus dependencias y sus paquetes para Python 3.14; y la [documentación de uv](https://docs.astral.sh/uv/concepts/projects/config/#project-packaging) sobre `tool.uv.package = false`, que no construye ni instala el proyecto.
- [endoflife.date: Python](https://endoflife.date/python), con las versiones 3.14.10 y 3.15.2.
- [Ubuntu 26.04 LTS, notas de la versión](https://documentation.ubuntu.com/release-notes/26.04/).
- [OVHcloud: VPS](https://www.ovhcloud.com/es/vps/), en su sitio para Latinoamérica, y [su catálogo público para Latinoamérica](https://ca.api.ovh.com/v1/order/catalog/public/vps?ovhSubsidiary=WS), con los precios, los datacenters y las imágenes; [el pedido bloqueado del 2026-11-08](https://community.ovhcloud.com/t/vps-2027-ordering-blocked-all-plans-greyed-out-on-italian-and-french-websites/54289), en su comunidad; y [un seguimiento no oficial de existencias](https://vps-in-stock.ovh/).
- Cloudflare R2: [tokens](https://developers.cloudflare.com/r2/api/s3/tokens/), [reglas de bloqueo](https://developers.cloudflare.com/r2/buckets/bucket-locks/) y [ciclo de vida](https://developers.cloudflare.com/r2/buckets/object-lifecycles/); y [alertas de presupuesto](https://developers.cloudflare.com/billing/manage/budget-alerts/).
- systemd: [`systemd.exec`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [`systemd.service`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), con `RestartSteps` desde la versión 254, y [`systemd-creds`](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html); y el [cgroup v2 de Linux](https://docs.kernel.org/admin-guide/cgroup-v2.html), con `memory.stat` y `memory.events`.
- GitHub REST: [comprobaciones de un commit](https://docs.github.com/en/rest/checks/runs) y [los PR de un commit](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit).

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
