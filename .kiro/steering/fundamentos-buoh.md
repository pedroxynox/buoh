---
inclusion: always
---

# Fundamentos de buoh

## Propósito

buoh es un bot multiplataforma de investigación cuantitativa, señales trazables y ejecución algorítmica controlada para índices de Deriv. Favorece evidencia reproducible, seguridad, control de riesgo y claridad antes que velocidad, apariencia o promesas de rendimiento.

## Alcance, público y etapas

- El primer público es el fundador en **uso propio**. La evolución a suscriptores externos y señales pagas es una decisión de producto aceptada, no un objetivo opcional.
- El MVP es un bot de señales en modo `shadow`: investiga, genera señales y posiciones hipotéticas, pero no envía órdenes reales.
- La ejecución `demo` y luego `real` son objetivos del producto. Las puertas técnicas, de seguridad, operación y cumplimiento regulan cuándo y en qué alcance se habilitan; no son una prohibición permanente de señales pagas ni dinero real.
- Separar siempre los planos de investigación, señales y ejecución. Una señal nunca concede permiso implícito para operar.
- Web administra investigación y auditoría; React Native sirve Android e iOS; Windows futuro usa Tauri 2. Una capa Android, si existe, es pasiva y nunca controla ejecución.

## Límites obligatorios

- Nunca prometer, presentar ni diseñar garantías de rentabilidad. Mostrar modo, período, muestra, costes, pérdidas, *drawdown*, limitaciones y versión de toda métrica de desempeño.
- No aceptar ni almacenar contraseñas de Deriv. Toda futura vinculación usa OAuth con PKCE, privilegios mínimos, intercambio de código en backend, tokens cifrados y revocables.
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

- Tratar `shadow`, `demo`, `real` y `pausado` como entornos incompatibles y visibles en API/UI/auditoría.
- Rechazar una intención de ejecución si autorización, política, frescura/calidad de datos, idempotencia, salud de bróker o *kill switch* no son válidos.
- Persistir y correlacionar intentos, respuestas, reintentos, órdenes, posiciones y reconciliaciones. Nunca reintentar ciegamente un resultado ambiguo.
- Todo cambio de datos, plataforma, seguridad, riesgo o alcance necesita documentación de decisión y puerta de calidad.
- Antes de señales comerciales o dinero real, exigir evaluación legal/de cumplimiento aplicable; no sustituirla con una conclusión técnica.

## Arquitectura y lenguajes preferidos

- TypeScript estricto es el lenguaje principal: Next.js/React (web), Expo/React Native (móvil), Fastify (API), `market-data-worker`, `signal-engine`, futuro `execution-gateway`, y paquetes compartidos de contratos/dominio/estrategia/riesgo/diseño.
- Python se limita a investigación cuantitativa por lotes, con contratos versionados con el resto del sistema; no es la ruta directa de órdenes.
- SQL/PostgreSQL + TimescaleDB protege invariantes, metadatos, auditoría y series; Parquet en almacenamiento S3-compatible guarda datos crudos; Redis solo sirve estado efímero/colas.
- Rust se limita al futuro contenedor Tauri 2 para Windows y a extensiones de rendimiento demostradas. Kotlin/Swift solo pueden aparecer en puentes nativos mínimos de Android/iOS.
- Mantener un contrato versionado entre TypeScript y Python; no duplicar fórmulas de producción sin vectores de prueba compartidos.

## Forma de trabajar

- Antes de agregar una capacidad, confirmar su etapa, su límite de seguridad y su puerta de calidad.
- Preferir cambios pequeños, auditables y documentados cuando afecten seguridad, datos, plataforma, riesgo o alcance.
- No introducir dependencias, servicios cloud, credenciales ni integraciones de terceros sin justificación técnica y revisión explícita.
- Usar español claro en documentación de producto y nombrar los conceptos de dominio de forma precisa y consistente.
- La identidad visual es nocturna, serena, accesible y orientada a observación; nunca gamificar riesgo o urgencia.
## Flujo de GitHub y revisión

- El repositorio de buoh comienza privado.
- El agente prepara cambios y los sube a ramas de trabajo; nunca sube cambios directamente a `main` ni crea pull requests mediante una identidad de agente.
- El usuario crea el pull request desde la rama ya subida con su identidad de GitHub, lo revisa y conserva la decisión de aprobar, solicitar cambios o fusionarlo.
- El agente no altera configuración de Git, identidad, autoría ni atribución para ocultar quién realizó un cambio.
- Antes de abrir un pull request, revisar `CONTRIBUTING.md`, ejecutar las verificaciones disponibles y resumir alcance, riesgos y documentación afectada.
- No incluir secretos, datos reales de mercado, tokens de Deriv, credenciales ni resultados sensibles en commits o pull requests.
