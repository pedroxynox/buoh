# buoh

**buoh** será un bot algorítmico multiplataforma para investigar patrones, publicar señales trazables y, cuando supere sus puertas de seguridad y cumplimiento, ejecutar operaciones autorizadas sobre índices de Deriv y, después, sobre instrumentos de MetaTrader 5 en Deriv MT5 y Vantage. Su nombre, lenguaje visual y comportamiento se inspiran en un búho: observación paciente, visión nocturna y decisiones explicables.

> **Estado vigente:** consulta [`PROJECT_STATUS.md`](PROJECT_STATUS.md). Aún no se presume estrategia validada, rentabilidad demostrada ni integración de dinero real.

Este README es un resumen de navegación; no sustituye las fuentes canónicas indicadas en [`AGENTS.md`](AGENTS.md).

## Empieza aquí

Cualquier persona o motor de IA debe leer, en orden:

1. [`AGENTS.md`](AGENTS.md): reglas de trabajo y jerarquía de autoridad.
2. [`PROJECT_STATUS.md`](PROJECT_STATUS.md): estado vigente y siguiente tarea.
3. [Plan ejecutable de Fase 1](docs/plan/fase-1-fundacion-de-datos.md).
4. Contratos, ADR y runbooks afectados por la tarea.

## Desarrollo actual

Fase 1 tiene contratos runtime (F1.1), normalización y calidad puras (F1.2) y, sobre PostgreSQL y almacenamiento S3-compatible locales, log raw-first, publicación y replay (F1.3). Todavía no conecta con Deriv ni ejecuta operaciones.

```text
pnpm install
pnpm run verify
pnpm run test:vectors
pnpm run test:integration                       # requiere infra/compose.yaml
pnpm run data:replay -- --dataset <dataset_id>  # añade --verify-only para solo integridad
```

pnpm usa el runtime Node fijado por el proyecto. Consulta [`packages/contracts`](packages/contracts/) para los esquemas ejecutables, [`packages/domain`](packages/domain/) para la normalización y las reglas de calidad puras y [`apps/market-data-worker`](apps/market-data-worker/) para publicación y replay. El entorno local está en el [runbook](docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

## Propósito

Convertir hipótesis de trading en un ciclo controlado: datos verificables, estrategias versionadas, *backtests* reproducibles, señales auditables, simulación, ejecución autorizada y reconciliación. buoh perseguirá evidencia de rentabilidad neta y sostenibilidad, no promesas de ganancia.

Usaremos **Deriv** como denominación e integración objetivo. "Binary" se considera el nombre histórico indicado por el proyecto; la documentación actual de la plataforma y de sus APIs pertenece a Deriv.

## Producto: tres planos separados

1. **Investigación:** datos, hipótesis, experimentos y evidencia estadística.
2. **Señales:** eventos explicables y versionados, visibles en web y móvil, con estado `shadow`, `demo` o `real` claramente diferenciado.
3. **Ejecución:** un servicio de servidor aislado que recibe únicamente intenciones aprobadas, aplica límites de riesgo, se comunica con Deriv y reconcilia el resultado. Ninguna interfaz de usuario envía órdenes directamente al bróker.

La estrategia inicial de lanzamiento será un **bot de señales en modo shadow**: genera señales y posiciones hipotéticas con datos vivos, sin enviar órdenes. La ejecución demostrativa y luego real son fases deliberadas del producto, no funciones descartadas.

## Modelo de lanzamiento

buoh se valida primero para **uso propio** y después evoluciona hacia **suscriptores externos**. Las señales pagas y la ejecución con dinero real son objetivos comerciales explícitos: las puertas de calidad regulan el momento y alcance de su lanzamiento, pero no constituyen una prohibición de producto. Véase el [modelo de lanzamiento](docs/producto/modelo-de-lanzamiento.md).

## Límites no negociables

- No se promete, publicita ni presupone rentabilidad. El rendimiento siempre se presenta neto de supuestos, con período, muestra, *drawdown* y limitaciones.
- No se ejecuta una estrategia real por un único *backtest* favorable. Debe superar investigación, observación *shadow*, pruebas demo, controles operativos y revisión de cumplimiento.
- No se piden ni almacenan contraseñas de Deriv. Una futura vinculación usará OAuth con privilegios mínimos, intercambio de código en backend y cifrado de tokens. MetaTrader 5, previsto después de Fase 1, no ofrece OAuth: la contraseña de las cuentas propias la guarda solo su terminal y los servicios de buoh nunca la reciben ([ADR-0007](docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)).
- No se gestionan fondos, depósitos o retiros de usuarios. buoh automatiza únicamente acciones explícitamente autorizadas en una cuenta conectada, si la jurisdicción y el proveedor lo permiten.
- No se usa lectura de pantalla, *screen scraping*, servicios de accesibilidad ni superposiciones que capturen o interfieran con otras aplicaciones.
- Toda orden debe ser idempotente, auditable, limitada por una política de riesgo y reversible mediante un interruptor de emergencia cuando el instrumento lo permita.

Las señales pagas, las señales con dinero real y la ejecución real son líneas de producto planificadas. Su habilitación requiere revisión legal y de cumplimiento específica a la jurisdicción y al modelo de distribución; esa revisión es una condición de lanzamiento seguro, no un bloqueo permanente. Esta documentación define ingeniería y control de producto, no asesoría legal o financiera.

## Clientes y plataformas

- **Web:** centro de investigación, control del bot, auditoría y administración de políticas.
- **Android e iOS:** clientes React Native para seguimiento, señales, estado de automatizaciones y autorizaciones seguras. iOS está previsto desde la arquitectura; no se promete una superposición global entre aplicaciones.
- **Windows (futuro):** cliente Tauri 2 que reutilizará dominio, contratos y diseño compartidos.

Una capa flotante seguirá siendo una capacidad Android opcional, pasiva y de consulta. Nunca será el mecanismo que dispara operaciones.

## Identidad de diseño

- **Carácter:** sereno, preciso, nocturno; no lúdico ni estimulante de sobreoperación.
- **Paleta:** noche `#0A101C` como fondo, niebla `#F4F6FB` para el texto, luna `#F0E5C6` para la acción principal y ámbar `#F2B544` solo para los ojos del búho y el acento de marca. La [guía de marca](docs/diseno/marca-buoh.md) es la fuente canónica y sustituye la paleta inicial.
- **Accesibilidad:** contraste WCAG AA como mínimo, comprobado por pruebas; el color nunca será la única señal de ganancia, pérdida, riesgo o estado.
- **Datos vivos:** toda vista muestra símbolo, fuente, zona horaria, intervalo, frescura, modo de ejecución y calidad de datos.

## Documentos de decisión

- [Estado actual](PROJECT_STATUS.md)
- [Plan ejecutable de Fase 1](docs/plan/fase-1-fundacion-de-datos.md)
- [Visión y alcance](docs/producto/vision-y-alcance.md)
- [Roadmap por puertas de calidad](docs/producto/roadmap.md)
- [Modelo de lanzamiento y comercialización](docs/producto/modelo-de-lanzamiento.md)
- [Arquitectura objetivo](docs/arquitectura/arquitectura-objetivo.md)
- [ADR-0001: plataforma y stack](docs/arquitectura/adr/0001-plataforma-y-stack.md)
- [ADR-0002: señales y ejecución controlada](docs/arquitectura/adr/0002-senales-y-ejecucion-controlada.md)
- [ADR-0003: lenguajes y límites](docs/arquitectura/adr/0003-lenguajes-y-limites.md)
- [ADR-0004: pipeline y reproducción de datos de Fase 1](docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md)
- [ADR-0005: persistencia local, formato físico y log raw-first de F1.3](docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md)
- [ADR-0006: alojamiento productivo en Render](docs/arquitectura/adr/0006-alojamiento-en-render.md)
- [ADR-0007: varias fuentes y MetaTrader 5](docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)
- [ADR-0008: línea visual, marca y clientes web](docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md)
- [Plan de la línea visual V1](docs/plan/linea-visual-v1.md)
- [Guía de marca](docs/diseno/marca-buoh.md)
- [Concepto de interfaz](docs/diseno/concepto-de-interfaz.md)
- [Funciones y disponibilidad](docs/producto/funciones-y-disponibilidad.md)
- [Contratos de dominio y eventos](docs/arquitectura/contratos-de-dominio.md)
- [Seguridad y rigor cuantitativo](docs/gobierno/seguridad-y-rigor-cuantitativo.md)
- [Protocolo de validación de estrategias](docs/gobierno/protocolo-de-validacion-de-estrategias.md)
- [Operación y control de riesgo](docs/gobierno/operacion-y-control-de-riesgo.md)
- [Runbook de ingesta de datos](docs/operacion/runbook-ingesta-de-datos.md)
- [Guía de contribución](CONTRIBUTING.md)

## Fuentes de plataforma

- [Resumen de APIs de Deriv](https://developers.deriv.com/docs/intro/api-overview/)
- [Datos de ticks de Deriv](https://developers.deriv.com/docs/data/ticks/)
- [Compra de contratos mediante WebSocket](https://developers.deriv.com/docs/trading/buy/)
- [Canal WebSocket demo de Deriv](https://developers.deriv.com/docs/options/ws-demo/)
- [Autenticación de Deriv](https://developers.deriv.com/docs/intro/authentication/)
- [OAuth 2.0 con PKCE de Deriv](https://developers.deriv.com/docs/intro/oauth/)
- [Ventanas `TYPE_APPLICATION_OVERLAY` de Android](https://developer.android.com/reference/android/view/WindowManager.LayoutParams)
- [Guías de revisión de App Store](https://developer.apple.com/app-store/review/guidelines/)

El contenido de las fuentes externas fue reformulado para cumplir con las restricciones de licencia.
