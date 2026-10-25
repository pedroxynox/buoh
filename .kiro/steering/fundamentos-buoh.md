---
inclusion: always
---

# Fundamentos de buoh

## Propósito

buoh es un bot multiplataforma de investigación cuantitativa, señales trazables y ejecución algorítmica controlada para índices de Deriv y, después, instrumentos de MetaTrader 5 en Deriv MT5 y Vantage (ADR-0007). Favorece evidencia reproducible, seguridad, control de riesgo y claridad antes que velocidad, apariencia o promesas de rendimiento.

## Protocolo obligatorio para agentes

- Antes de trabajar, leer [`AGENTS.md`](../../AGENTS.md), [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y los planes activos enlazados allí (`plan` y `parallel_plans`).
- Las conversaciones no sustituyen las fuentes canónicas del repositorio.
- Ante conflicto o decisión ausente, seguir el protocolo de `AGENTS.md`; no improvisar silenciosamente.

## Alcance, público y etapas

- El primer público es el fundador en **uso propio**. La evolución a suscriptores externos y señales pagas es una decisión de producto aceptada, no un objetivo opcional.
- El MVP es un bot de señales en modo `shadow`: investiga, genera señales y posiciones hipotéticas, pero no envía órdenes reales.
- La ejecución `demo` y luego `real` son objetivos del producto. Las puertas técnicas, de seguridad, operación y cumplimiento regulan cuándo y en qué alcance se habilitan; no son una prohibición permanente de señales pagas ni dinero real.
- Separar siempre los planos de investigación, señales y ejecución. Una señal nunca concede permiso implícito para operar.
- Web administra investigación y auditoría; React Native sirve Android e iOS; Windows futuro usa Tauri 2. Una capa Android, si existe, es pasiva y nunca controla ejecución.

## Límites obligatorios

- Nunca prometer, presentar ni diseñar garantías de rentabilidad. Mostrar modo, período, muestra, costes, pérdidas, *drawdown*, limitaciones y versión de toda métrica de desempeño.
- No aceptar ni almacenar contraseñas de Deriv. Toda futura vinculación usa OAuth con PKCE, privilegios mínimos, intercambio de código en backend, tokens cifrados y revocables. Las cuentas MT5 propias siguen la excepción acotada de [ADR-0007](../../docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md).
- No gestionar depósitos, retiros, custodia ni fondos de usuarios.
- Ningún navegador, móvil, overlay o estrategia se conecta directamente al bróker para ejecutar. Solo `execution-gateway`, aislado en servidor, puede hacerlo después de política de riesgo, autorización, idempotencia y auditoría.
- No usar captura de pantalla, OCR de otras aplicaciones, servicios de accesibilidad, *screen scraping* ni controles que imiten/interfieran con otra app.
- No habilitar ejecución real para jurisdicciones, instrumentos, cuentas o tipos de contrato no aprobados explícitamente.

## Rigor de datos y estrategias

- Tratar datos crudos como inmutables y preservar fuente, símbolo, tiempos UTC, versión de esquema y banderas de calidad.
- Toda estrategia debe registrar datos, parámetros, versión, período, costes/supuestos, política de riesgo y semilla si aplica.
- Separar temporalmente entrenamiento, validación y prueba fuera de muestra. Evitar mirar el futuro, fugas, selección y sobreajuste.
- Registrar resultados negativos, muestra, *drawdown*, exposición, sensibilidad, interrupciones y limitaciones; la tasa de acierto sola no basta.
- Versionar estrategia, señal y política. Un cambio crea una nueva versión y vuelve a pasar por validación.
- Mantener funciones de dominio, indicadores y políticas puras, deterministas y probadas.

## Seguridad y ejecución

- Mantener separados `deployment_environment`, `execution_mode`, `strategy_lifecycle` y `service_health`. Los modos son `disabled`, `shadow`, `demo` y `real`; `paused` es un estado operativo o de estrategia, nunca un entorno.
- Rechazar una intención de ejecución si autorización, política, frescura/calidad de datos, idempotencia, salud de bróker o *kill switch* no son válidos.
- Persistir y correlacionar intentos, respuestas, reintentos, órdenes, posiciones y reconciliaciones. Nunca reintentar ciegamente un resultado ambiguo.
- Todo cambio de datos, plataforma, seguridad, riesgo o alcance necesita documentación de decisión y puerta de calidad.
- Antes de señales comerciales o dinero real, exigir evaluación legal/de cumplimiento aplicable; no sustituirla con una conclusión técnica.

## Arquitectura y lenguajes preferidos

- TypeScript estricto es el lenguaje principal: Next.js/React (web), Expo/React Native (móvil), Fastify (API), `market-data-worker`, `signal-engine`, futuro `execution-gateway`, y paquetes compartidos de contratos/dominio/estrategia/riesgo/diseño.
- Python se limita a investigación cuantitativa por lotes, con contratos versionados con el resto del sistema; no es la ruta directa de órdenes.
- SQL/PostgreSQL protege invariantes, metadatos, auditoría y series; Parquet en almacenamiento S3-compatible guarda normalizados. Fase 1 usa PostgreSQL estándar y difiere TimescaleDB/Redis hasta demostrar su necesidad.
- Rust se limita al futuro contenedor Tauri 2 para Windows y a extensiones de rendimiento demostradas. Kotlin/Swift solo pueden aparecer en puentes nativos mínimos de Android/iOS. MQL5 se limita al puente de MetaTrader 5 (ADR-0007).
- Mantener un contrato versionado entre TypeScript y Python; no duplicar fórmulas de producción sin vectores de prueba compartidos.

## Forma de trabajar

- Antes de agregar una capacidad, confirmar su etapa, su límite de seguridad y su puerta de calidad.
- Actualizar `PROJECT_STATUS.md` cuando cambien fase, objetivo, siguiente tarea, bloqueos o evidencia; no usarlo como changelog.
- Preferir cambios pequeños, auditables y documentados cuando afecten seguridad, datos, plataforma, riesgo o alcance.
- No introducir dependencias, servicios cloud, credenciales ni integraciones de terceros sin justificación técnica y revisión explícita.
- Usar español claro en documentación de producto y nombrar los conceptos de dominio de forma precisa y consistente.
- La identidad visual es nocturna, serena, accesible y orientada a observación; nunca gamificar riesgo o urgencia.

## Flujo de GitHub y revisión

- El repositorio de buoh comienza privado.
- El agente prepara cambios en ramas de trabajo, crea y actualiza los pull requests mediante la automatización configurada; nunca sube cambios directamente a `main`.
- El usuario revisa los pull requests y conserva la decisión de aprobar, solicitar cambios o fusionarlos.
- El agente no altera configuración de Git, identidad, autoría ni atribución para ocultar quién realizó un cambio.
- Antes de abrir un pull request, revisar `CONTRIBUTING.md`, ejecutar las verificaciones disponibles y resumir alcance, riesgos y documentación afectada.
- No incluir secretos, datos reales de mercado, tokens de Deriv, credenciales ni resultados sensibles en commits o pull requests.
