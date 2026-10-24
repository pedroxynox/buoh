# Arquitectura objetivo

## Principio rector

buoh separa de forma estricta **investigación**, **señales** y **ejecución**. La ejecución forma parte del producto objetivo, pero nunca comparte proceso, permisos ni ruta directa con la interfaz o con un experimento sin aprobar.

Una pantalla no coloca órdenes. Un modelo no coloca órdenes. Solo una pasarela de ejecución de servidor puede convertir una intención ya aprobada en una acción hacia Deriv, después de verificar autorización, política de riesgo, estado del mercado y consistencia operativa.

## Topología objetivo

```text
Deriv: datos públicos ──► ingesta/validación ──► almacenamiento reproducible
                                                   ├── frames fuente NDJSON/gzip (S3-compatible)
                                                   ├── ticks normalizados Parquet
                                                   └── metadatos/manifiestos PostgreSQL
                                                                  │
                                                                  ▼
                                                        investigación Python
                                                                  │
                                                                  ▼
                                                registro versionado de estrategias
                                                   │
                                                   ▼
                   estrategia apta ──► motor de señales ──► SignalEvent firmado
                                                   │                 │
                                                   │                 ├── web / Android / iOS / futuro Windows
                                                   │                 └── notificaciones
                                                   ▼
                                  motor de política y riesgo de ejecución
                                                   │
                                      intento idempotente + libro de auditoría
                                                   │
                                                   ▼
                               pasarela de ejecución / adaptador Deriv
                                                   │
                                                   ▼
                            estado de orden y posición ◄── reconciliación
```

Deriv es la primera fuente. Después de Fase 1, MetaTrader 5 (Deriv MT5 y Vantage) entra como fuentes adicionales mediante un puente MQL5 dentro de la terminal MT5. Cada fuente tiene su propio adaptador, normalizador, perfil y log, y comparte el almacenamiento, la publicación y el replay ([ADR-0007](adr/0007-varias-fuentes-y-metatrader-5.md)).

Deriv ofrece datos, operaciones en tiempo real y sesiones demo/real mediante APIs separadas. Su canal público es útil para ingesta inicial; los canales autenticados requieren una sesión válida para acciones de trading. [Resumen de API](https://developers.deriv.com/docs/intro/api-overview/) · [Compra de contrato](https://developers.deriv.com/docs/trading/buy/) · [Canal demo](https://developers.deriv.com/docs/options/ws-demo/)

## Monorepo propuesto

```text
buoh/
├── apps/
│   ├── api/                     # Fastify: identidad, consulta y API de producto
│   ├── market-data-worker/      # ingesta, validación, normalización y trabajos de datos
│   ├── signal-engine/           # evaluación en vivo y producción de SignalEvent
│   ├── execution-gateway/       # futuro: único proceso con permiso de ejecutar
│   ├── web/                     # Next.js: investigación, auditoría y control
│   ├── mobile/                  # Expo/React Native: Android e iOS
│   └── desktop/                 # futuro: Tauri 2 para Windows
├── packages/
│   ├── contracts/               # Zod/OpenAPI/eventos versionados
│   ├── domain/                  # tipos, unidades, cálculos puros y reglas compartidas
│   ├── strategy-sdk/            # interfaz restringida de estrategia; sin red ni secretos
│   ├── risk-policy/             # evaluador puro de límites y elegibilidad
│   ├── broker-adapters/         # interfaces y adaptadores aislados: Deriv y, después, MT5
│   ├── design-system/           # tokens y componentes visuales de buoh
│   └── config/                  # configuración común de calidad y compilación
├── research/
│   └── python/                  # análisis estadístico reproducible por lotes
├── infra/                       # Docker local, IaC, secretos y despliegue
├── docs/
└── .kiro/steering/
```

`execution-gateway` no se creará con permisos reales hasta completar la fase demo. Su contrato sí se diseñará temprano para impedir que los clientes o el motor de señales dependan del bróker directamente.

## Tecnologías elegidas

| Área | Decisión | Motivo |
|---|---|---|
| Lenguaje de producto | TypeScript estricto | Unifica clientes, API, contratos, políticas y adaptadores. |
| Web | Next.js + React | Estación de investigación, auditoría y administración densa. |
| Móvil | Expo + React Native | Un código de producto para Android e iOS; módulos nativos aislados cuando hagan falta. |
| API | Fastify + TypeScript | Validación explícita, REST y streaming para el producto. |
| Investigación cuantitativa | Python | Ecosistema analítico maduro, aislado de la ruta de órdenes. |
| Frames crudos | NDJSON/gzip en almacenamiento S3-compatible | Conserva texto fuente exacto y permite reproducción del adaptador. |
| Ticks normalizados | Parquet en almacenamiento S3-compatible | Consulta analítica portable y económica. |
| Metadatos / órdenes | PostgreSQL; TimescaleDB solo con necesidad medida | Integridad transaccional, procedencia y futura auditoría. |
| Cola/caché futura | Redis cuando exista concurrencia que lo requiera | Estado efímero y control de flujo; nunca fuente de verdad. |
| Escritorio Windows futuro | Tauri 2 + React compartido | Huella reducida y reutilización de paquetes TypeScript. |
| Herramientas | pnpm + Turborepo + Docker Compose | Entorno local y tareas deterministas. |

## Fronteras de dominio

### Datos e investigación

Los frames se registran primero con fuente, conexión, tiempo de recepción, payload UTF-8 exacto y hash. `symbol` y `event_time_utc` solo aparecen después de una normalización válida. Velas, indicadores, señales y métricas son derivados regenerables.

Una estrategia es una versión inmutable que recibe datos explícitos y devuelve una intención declarativa; no tiene acceso a red, reloj global, credenciales ni base de datos. Python puede investigar y proponer una estrategia, pero la versión que se publica en vivo debe ejecutarse por el motor controlado y tener un contrato determinista.

### Señales

Un `SignalEvent` contiene como mínimo identificador, estrategia y versión, símbolo, instante de emisión, vencimiento, condición, conjunto/ventana de datos, modo (`shadow`, `demo`, `real`), estado de calidad y referencia de evidencia. Una señal no es una orden ni tiene permiso implícito para crearla.

### Ejecución

La pasarela acepta un `ExecutionIntent` solo si todos estos controles pasan:

1. estrategia y versión aptas para el entorno objetivo;
2. autorización activa del usuario o de la operación, cuando aplique;
3. política de riesgo vigente para usuario, estrategia, instrumento y entorno;
4. señal no vencida, datos no degradados y reloj dentro de tolerancia;
5. clave de idempotencia nueva y correlación con su señal;
6. conectividad y estado de bróker aptos;
7. *kill switch* global, por estrategia y por usuario desactivado.

Cada intento se persiste antes de enviarse. Los eventos de solicitud, respuesta, reintento, actualización, rechazo y reconciliación se anexan a un libro de auditoría inmutable. Un fallo ambiguo nunca se convierte en un reintento ciego: se consulta el estado del bróker antes de decidir.

### Riesgo

`risk-policy` será un paquete puro y versionado. Contendrá límites técnicos aprobados: instrumentos permitidos, entorno, monto máximo, exposición concurrente, pérdidas/operaciones por ventana, antigüedad máxima de señal, frecuencia, horarios, condiciones de calidad y acciones de corte. Los valores concretos se configurarán tras la investigación; no se codificarán como supuestos globales.

## Autenticación y cuentas de Deriv

El MVP trabaja con datos públicos y *shadow trading*. La integración demo y real utilizará OAuth 2.0 Authorization Code + PKCE, `state` anti-CSRF, intercambio de código en el backend, tokens de duración limitada, cifrado en reposo, rotación, revocación y privilegios mínimos. Nunca se aceptan contraseñas de Deriv ni se exponen secretos en web/móvil.

MetaTrader 5 no ofrece autorización delegada como OAuth. Sus contraseñas, solo de cuentas propias, las guarda la terminal MT5 en el equipo de la terminal y los servicios de buoh nunca las reciben ([ADR-0007](adr/0007-varias-fuentes-y-metatrader-5.md)).

Deriv documenta OAuth para autorización delegada y distingue sus canales públicos de los autenticados. La documentación también indica que una compra de contrato requiere una sesión válida. [Autenticación](https://developers.deriv.com/docs/intro/authentication/) · [OAuth con PKCE](https://developers.deriv.com/docs/intro/oauth/) · [Buy](https://developers.deriv.com/docs/trading/buy/)

La aplicación no gestionará depósitos, retiros ni custodia. Antes de solicitar permisos de trading o conectar cuentas reales, se revisarán las condiciones de Deriv, las jurisdicciones habilitadas y el modelo de cumplimiento con asesoría legal cualificada.

## Frontera de plataformas

### Web

Es la superficie principal de investigación, auditoría y configuración. Puede iniciar solicitudes de configuración, pero no posee credenciales de bróker ni abre una conexión de ejecución directa.

### Android e iOS

Las aplicaciones React Native muestran estado, señales y alertas, y permiten revisar autorizaciones desde flujos autenticados. Las solicitudes sensibles se confirman contra el servidor; el móvil no ejecuta estrategias críticas en segundo plano ni guarda secretos de servidor.

iOS es un cliente objetivo normal desde el diseño de React Native. La experiencia utilizará notificaciones, widgets y Live Activities cuando sean apropiados, siempre dentro de las [guías de App Review](https://developer.apple.com/app-store/review/guidelines/). No existe una promesa de superposición global entre aplicaciones.

### Android overlay (opcional)

Una futura capa `TYPE_APPLICATION_OVERLAY` será de consulta, apagable y no táctil sobre la aplicación subyacente. No contiene controles de ejecución, credenciales ni contenido que imite a otra aplicación. Android documenta restricciones de confianza y de paso de toques para este tipo de capas. [Referencia oficial](https://developer.android.com/reference/android/view/WindowManager.LayoutParams)

### Windows (futuro)

Tauri encapsulará un cliente React que reutiliza `packages/domain`, `packages/contracts`, `packages/risk-policy` y `packages/design-system`. No empaquetará la pasarela de ejecución ni el entorno Python; toda acción sigue pasando por APIs autenticadas de buoh.

### Terminal MetaTrader 5 (futuro)

La terminal MT5 con el puente corre en un PC dedicado del propietario o en un servidor Windows o Linux con Wine; la elección está pendiente. Ese equipo es infraestructura de servidor de buoh, no un cliente, y el cliente Tauri no lo incluye ([ADR-0007](adr/0007-varias-fuentes-y-metatrader-5.md)).

## Despliegue y fiabilidad

- **Desarrollo de Fase 1:** Docker Compose para PostgreSQL estándar y almacenamiento S3-compatible local; datos sintéticos y públicos.
- **Alojamiento productivo:** Render para PostgreSQL, API y web ([ADR-0006](adr/0006-alojamiento-en-render.md)). Siguen pendientes el alojamiento de `market-data-worker`, el proveedor S3-compatible productivo y la distribución de la app móvil. El despliegue sigue diferido por el plan de Fase 1.
- **Fases posteriores:** TimescaleDB o Redis se incorporan solo si una ADR documenta la necesidad medida.
- **Preproducción:** estrategia *shadow*, pruebas de resiliencia, telemetría, migraciones y prueba demo sin secretos productivos.
- **Producción de señales:** observabilidad de datos, eventos y latencia; interrupción automática si la calidad se degrada.
- **Producción de ejecución:** entorno separado, acceso mínimo, despliegues canary, monitorización de reconciliación, alarmas y pruebas periódicas de *kill switch*.

No se desplegará ejecución real hasta conocer jurisdicción, modelo comercial, límites de exposición, retención de datos, soporte operativo y condiciones aplicables de la plataforma.
