# ADR-0001: Plataforma, fronteras y stack inicial

- **Estado:** Parcialmente sustituida por ADR-0002 (decisión 5)
- **Fecha:** 2026-10-17
- **Decisores:** Dirección técnica de buoh

## Contexto

buoh necesita una estación web de investigación, una aplicación móvil de observación y una ruta realista hacia Windows. También requiere análisis cuantitativo reproducible sobre series temporales sin convertir prematuramente una investigación en un sistema de ejecución de trading.

Una solución de un solo cliente, una API ligada a la interfaz o cálculos no reproducibles harían costosa la expansión y difícil la auditoría. Un primer producto de trading con credenciales o ejecución elevaría innecesariamente el riesgo técnico y de cumplimiento.

## Decisión

1. Usar un **monorepo TypeScript** con `pnpm` y `Turborepo` para API, web, móvil, contratos y dominio compartido.
2. Construir el laboratorio con **Next.js/React**, el compañero móvil con **Expo/React Native** y la API con **Fastify**.
3. Conservar investigación estadística de alto nivel en **Python**, ejecutada como trabajos aislados y reproducibles; los resultados cruzan la frontera mediante archivos y contratos versionados.
4. Mantener datos crudos inmutables en **Parquet/S3-compatible**, metadatos en **PostgreSQL + TimescaleDB** y estado efímero en **Redis**.
5. Hacer que el MVP sea **solo de observación e investigación**: datos públicos, experimentos, *backtests* y alertas; sin vinculación de cuentas ni envío de órdenes.
6. Diseñar Windows para una futura aplicación **Tauri 2** que reutilice paquetes React/TypeScript; no construirla hasta validar el núcleo web y móvil.
7. Tratar la capa sobre otras aplicaciones como una capacidad Android opcional, pasiva y posterior; iOS tendrá capacidades nativas equivalentes de sistema, no una promesa de superposición global.

## Consecuencias positivas

- Los modelos de dominio, validaciones y lenguaje visual se comparten entre superficies.
- Los cálculos investigables pueden aprovechar el ecosistema Python sin filtrar complejidad a clientes.
- La procedencia de datos y resultados puede mantenerse de extremo a extremo.
- La ausencia de ejecución real reduce significativamente el impacto de un error de producto.
- La futura versión Windows no obliga a migrar la aplicación web ni a adoptar Electron.

## Consecuencias y costes aceptados

- Mantendremos TypeScript y Python, con un contrato explícito entre ambos; no se permitirá intercambio ad hoc de CSV sin esquema.
- Expo será suficiente para el móvil general, pero una futura capa Android requerirá compilación nativa y no funcionará en Expo Go.
- TimescaleDB, MinIO y Redis añaden servicios locales; se justifican por la naturaleza de series temporales y reproducibilidad, no por moda.
- La primera versión puede parecer menos espectacular que un bot operativo, pero estará en condiciones de demostrar evidencia antes de asumir riesgo.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Flutter para toda la interfaz | Implicaría Dart y una segunda pila sin mejorar los contratos del servidor; TypeScript optimiza la velocidad inicial del equipo. |
| Solo Next.js, sin API/worker separados | Mezclaría captura continua, trabajos largos e interfaz en un mismo ciclo de vida. |
| Electron como objetivo de escritorio | Es válido, pero Tauri ofrece una huella más contenida para una futura utilidad de investigación. |
| Guardar todos los ticks solo en PostgreSQL | Aumenta coste y dificulta conservar datos crudos portables a escala. |
| Incluir ejecución de operaciones desde el inicio | No hay evidencia suficiente, eleva riesgos y contradice el propósito experimental. |
| Usar accesibilidad o captura de pantalla para la capa móvil | Es invasivo, frágil y contrario a los límites de seguridad de buoh. |

## Condiciones de revisión

Revisar esta ADR si cambia cualquiera de estos factores: modelo de distribución, jurisdicción, volumen de datos medido, necesidad de colaboración multiusuario, disponibilidad de APIs de Deriv o requisitos de una integración de cuenta aprobada.
