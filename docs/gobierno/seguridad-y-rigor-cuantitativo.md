# Seguridad y rigor cuantitativo

## 1. Regla de oro

**Una estrategia no es conocimiento porque ganó en el pasado, y una señal no es una orden porque exista.** buoh debe conservar evidencia suficiente para reproducir, cuestionar, descartar y, solo en casos aprobados, automatizar una decisión.

El producto puede publicar señales y ejecutar estrategias autorizadas, pero no se comunica como garantía de rentabilidad ni como asesoría financiera personalizada. Toda métrica debe indicar modo, período, supuestos, tamaño de muestra, limitaciones y pérdidas observadas.

## 2. Ciclo de vida obligatorio de una estrategia

```text
Idea → especificación inmutable → revisión → entrenamiento → validación
     → prueba fuera de muestra → réplica → shadow vivo → demo → real controlado
     → monitoreo continuo → pausa, iteración o retiro
```

Para avanzar entre etapas, una estrategia debe tener:

- identificador, versión semántica y propietario responsable;
- fuente, símbolos, rango, zona horaria, huella de datos y controles de calidad;
- reglas completas de entrada, salida, dimensionamiento, condiciones de invalidez y política aplicable;
- parámetros declarados antes de ejecutar la prueba final;
- semilla aleatoria cuando corresponda;
- versión del motor de cálculo y entorno de ejecución;
- resultados completos, incluidos negativos, interrupciones y rechazo de operaciones;
- criterio de promoción y criterio de retiro explícitos.

La promoción de una versión crea una nueva versión; no se modifican parámetros de una estrategia activa sin nuevo ciclo de validación.

## 3. Controles contra resultados engañosos

### Sesgos que se deben prevenir

- **Mirar el futuro:** ninguna regla usa datos posteriores al instante evaluado.
- **Sobreajuste:** la prueba fuera de muestra no se reutiliza para elegir parámetros.
- **Supervivencia y selección:** se conservan universo, exclusiones y cambios de símbolo.
- **Fugas de datos:** conjuntos, indicadores y uniones temporales se validan antes de una simulación.
- **Costes omitidos:** todo resultado declara coste, retraso, *slippage* o la imposibilidad de estimarlos.
- **Métricas aisladas:** tasa de acierto sin pérdidas, *drawdown*, exposición, muestra y sensibilidad no es evidencia suficiente.
- **Deriva en vivo:** cambios de datos, mercado o latencia deben compararse contra el contexto de validación.

### Baselines y afirmaciones de desempeño

Cada experimento se compara contra una regla nula o simple adecuada y contra variaciones razonables de sus parámetros. Solo se publica desempeño con modo (`backtest`, `shadow`, `demo` o `real`), costos, intervalo, muestra, versión y limitaciones.

No se permite usar en nombre de producto, interfaz o marketing términos que impliquen certeza, seguridad de ganancia o rentabilidad garantizada.

## 4. Contrato de datos

La forma y semántica canónicas están en [contratos de dominio](../arquitectura/contratos-de-dominio.md) y, para Fase 1, en [ADR-0004](../arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md). Gobierno no mantiene una segunda definición de campos.

Todo frame crudo conserva fuente, conexión, tiempo de recepción, payload UTF-8 exacto, hash y versión del conector. Los ticks válidos añaden símbolo, tiempo de evento y cotización decimal. Incidencias, normalizados y manifiestos son append-only o regenerables; nunca sustituyen ni corrigen silenciosamente el raw.

## 5. Seguridad de aplicación

- Principio de privilegio mínimo, separación de entornos y separación de deberes.
- Secretos solo en gestor de secretos o variables de despliegue; nunca en repositorio, cliente ni registros.
- Cifrado en tránsito y en reposo para tokens o datos sensibles futuros.
- Autenticación de usuarios de buoh separada de cuentas de terceros.
- Registro de auditoría de estrategias, políticas, autorizaciones, cambios, órdenes e incidentes.
- Dependencias bloqueadas, análisis estático, revisión de código y actualización planificada.
- Telemetría operativa sin tokens, credenciales ni datos personales innecesarios.
- Ninguna aplicación cliente contiene permiso suficiente para ejecutar contra el bróker.

## 6. Política sobre Deriv y credenciales

La integración de ejecución comienza en demo. La autorización se realizará con OAuth 2.0 Authorization Code + PKCE, verificación de `state`, intercambio de código en servidor, privilegios mínimos y tokens revocables; no se aceptarán contraseñas. Las credenciales se cifran, se limitan a la cuenta/entorno autorizado y se revocan al desconectar.

Deriv documenta OAuth para delegar autorización y exige sesión válida para su operación de compra. [Autenticación](https://developers.deriv.com/docs/intro/authentication/) · [OAuth con PKCE](https://developers.deriv.com/docs/intro/oauth/) · [Buy](https://developers.deriv.com/docs/trading/buy/)

**Excepción acotada para MetaTrader 5** ([ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)). MT5 no ofrece OAuth. Solo para cuentas MT5 del propietario:

- para datos se usa la contraseña de inversor, que no permite operar;
- la contraseña maestra solo se usa en cuentas demo hasta que Fase 5 apruebe una cuenta real concreta;
- la contraseña vive solo en la terminal MT5 de su equipo, y buoh nunca la recibe ni la guarda;
- el puente se identifica ante buoh con una credencial propia, revocable y distinta.

La contraseña principal de la cuenta Deriv y las contraseñas de terceros siguen prohibidas.

El producto no administra depósitos, retiros ni fondos. Antes de ofrecer señales comerciales o ejecución real, se necesita evaluación legal y de cumplimiento específica para las jurisdicciones, el público y las condiciones de Deriv. Esa evaluación no se sustituye por una decisión técnica.

## 7. Señales y ejecución

Una señal debe incluir estrategia, versión, símbolo, instante, vencimiento, condición, calidad, modo y enlace a evidencia. Los modos `shadow`, `demo` y `real` son visibles y no intercambiables.

Una intención de ejecución se rechaza si falla cualquiera de los siguientes controles:

- autorización ausente, revocada o fuera de alcance;
- estrategia o política no apta para el entorno;
- datos degradados, señal vencida o reloj fuera de tolerancia;
- instrumento, horario, cantidad, exposición o frecuencia no permitidos;
- duplicado o correlación de orden inconsistente;
- *kill switch* activo o estado del bróker no confirmado.

Toda acción se registra primero, tiene clave de idempotencia y se reconcilia contra el estado de Deriv. Si el resultado de una solicitud es ambiguo, buoh consulta y reconcilia antes de reintentar. Un incidente de integridad o calidad pausa la estrategia por defecto.

## 8. Política de capa Android

Una capa Android es opcional y solo informativa:

- se activa manualmente y se desactiva desde la propia capa y desde ajustes;
- no captura gestos destinados a la aplicación inferior;
- no muestra credenciales, confirmaciones de trading ni controles de ejecución;
- no inspecciona el contenido bajo ella ni usa accesibilidad para obtener contexto;
- se somete a pruebas de seguridad, accesibilidad, consumo y políticas de distribución antes de ser publicada.

## 9. Puertas de calidad

| Capacidad | Evidencia mínima para aprobarla |
|---|---|
| Nuevo conector de datos | contrato, datos de prueba, monitor de huecos y reproducción de lote |
| Nuevo indicador | definición matemática, pruebas deterministas y unidades explícitas |
| Nueva estrategia | conjuntos temporales separados, costes declarados, línea base y revisión |
| Señal `shadow` | explicación verificable, caducidad, límites de frecuencia y prueba de falsos positivos |
| Señal comercial | desempeño contextualizado, trazabilidad, revisión de cumplimiento y contenido no engañoso |
| Ejecución demo | OAuth seguro, idempotencia, reconciliación, fallos simulados y *kill switch* probado |
| Ejecución real | todas las puertas anteriores, revisión legal/comercial aplicable, controles operativos y aprobación explícita |
| Overlay Android | revisión de permisos, amenaza, no interferencia y validación de distribución |
