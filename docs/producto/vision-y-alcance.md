# Visión y alcance de buoh

## 1. Tesis de producto

buoh será un bot de trading construido como un sistema de evidencia: investiga hipótesis, publica señales y ejecuta únicamente estrategias autorizadas que hayan pasado controles técnicos y operativos. La ambición es encontrar una expectativa positiva neta de costes; la disciplina es aceptar que ningún modelo garantiza resultados futuros.

La precisión significa datos íntegros, cálculos deterministas, control de sesgos, órdenes reconciliadas y comunicación honesta de incertidumbre. No significa certeza de ganancias ni permiso para omitir controles.

La primera integración será Deriv, con un universo inicial de índices que se fijará después de inventariar los símbolos y condiciones disponibles. Antes de presentar un instrumento, buoh conservará símbolo, denominación oficial, horario, granularidad, condiciones y versión de la fuente.

## 2. Problema que resolvemos

Los bots de trading fallan con frecuencia por mezclar reglas no versionadas, datos de procedencia incierta, ajustes retrospectivos, señales sin contexto y órdenes sin reconciliación. buoh debe imponer un ciclo único:

1. capturar y validar datos con procedencia;
2. definir una estrategia completa e inmutable;
3. medirla contra líneas base en entrenamiento, validación y prueba fuera de muestra;
4. ejecutarla en modo *shadow* y comparar expectativa con observación;
5. emitir señales explicables y con vencimiento;
6. habilitar demo y, solo después, ejecución real mediante una puerta de riesgo;
7. reconciliar cada intento, orden, contrato, resultado y excepción.

## 3. Producto, usuarios y lanzamiento

### Planos de producto

| Plano | Función | Estado de una salida |
|---|---|---|
| Investigación | Crear hipótesis y evidencia | `research` |
| Señales | Comunicar una condición de estrategia y su evidencia | `shadow`, `demo` o `real` |
| Ejecución | Aplicar una intención de estrategia bajo una política de riesgo | `disabled`, `demo` o `real` |

La misma señal no puede cambiar de plano silenciosamente. La interfaz, API y auditoría deben mostrar siempre su modo y la versión de estrategia que la originó.

### Secuencia de lanzamiento decidida

1. **Uso propio:** el fundador valida datos, estrategias, señales y operación bajo su propio control.
2. **Beta externa controlada:** un grupo limitado puede consumir señales con modo y evidencia explícitos.
3. **Suscripciones externas:** las señales pagas son un producto previsto, no una posibilidad descartada.
4. **Ejecución autorizada:** el dinero real se habilita por alcance aprobado, estrategia, cuenta, política e instrumento; no por una opción general de interfaz.

Las puertas de calidad y cumplimiento determinan cuándo pasa cada etapa, no si el proyecto puede comercializar señales o usar dinero real. El detalle se conserva en [modelo de lanzamiento](modelo-de-lanzamiento.md).

### Usuarios

- **Investigador/operador propio:** crea hipótesis, revisa evidencia y autoriza una estrategia apta.
- **Suscriptor de señales:** recibe señales con contexto, versión, vencimiento y métricas, sin falsas promesas.
- **Usuario de ejecución autorizada:** vincula una cuenta permitida y decide qué estrategia/política puede automatizarse.
- **Operador de plataforma:** administra salud del sistema, permisos, interrupciones de emergencia y auditoría; no puede alterar resultados históricos.

## 4. Alcance por etapa

### MVP — bot de señales en modo shadow para uso propio

Debe incluir:

- catálogo de símbolos y captura pública de *ticks* de Deriv;
- almacenamiento crudo versionado, calidad de datos y trazabilidad;
- definiciones de estrategia y experimentos reproducibles;
- *backtests* con costes, latencia y supuestos declarados;
- motor vivo que genere señales y posiciones hipotéticas sin órdenes reales;
- panel web para investigación, estrategia, desempeño y diario del bot;
- clientes móvil Android/iOS para señales, estado, alertas y lectura de evidencia;
- contratos de señal, registro de eventos, límites de frecuencia y alertas de salud.

### Producto de señales para suscriptores externos

Las señales pagas son una línea de negocio planeada. Antes de abrir una beta externa, el producto debe incorporar derechos de acceso, historial de entrega, modo de señal inconfundible, desempeño contextualizado y restricciones de jurisdicción/instrumento cuando sean aplicables.

Una señal marcada `real` no es una garantía ni equivale a una orden automática para el suscriptor. Señales y ejecución conservan autorizaciones y permisos separados.

### Después del MVP — ejecución demo

Debe incorporar una pasarela aislada hacia la cuenta demo de Deriv, políticas de riesgo, confirmación de autorizaciones, idempotencia, reconciliación, *kill switch* y pruebas de fallo de red. Solo estrategias aprobadas podrán operar en demo.

### Producto de ejecución real — objetivo comercial condicionado

La ejecución real es una meta del producto y no una restricción permanente. Solo puede habilitarse después de cumplir las puertas cuantitativas, de seguridad, de operación, de Deriv y de cumplimiento definidas en el roadmap. El alcance inicial será una lista explícita de instrumentos, estrategias, tipos de contrato, jurisdicciones y perfiles de usuario permitidos; todo lo demás quedará bloqueado por defecto.

### Fuera de alcance

- Garantías de rentabilidad o marketing que presente hipótesis como certezas.
- Gestión de fondos, depósitos, retiros, custodia o acceso a contraseñas de usuarios.
- Operaciones enviadas desde navegador, móvil o una capa flotante directamente a Deriv.
- Copia de pantalla de terceros, OCR, automatización por accesibilidad o superposición que imite otra aplicación.
- Cualquier mercado, país, instrumento o tipo de usuario no aprobado explícitamente para el producto.

## 5. Rentabilidad: cómo se tratará correctamente

La rentabilidad es una hipótesis medible, no una promesa. buoh solo podrá mostrar afirmaciones de desempeño si especifica:

- modo (`backtest`, `shadow`, `demo` o `real`);
- período, instrumentos, tamaño de muestra, fuente y costes asumidos;
- rendimiento neto, *drawdown*, exposición, distribución de pérdidas y sensibilidad;
- versión de estrategia y política de riesgo;
- si hubo interrupciones, datos incompletos o intervención humana.

Una tasa de acierto aislada, una curva de capital única o un resultado favorable en entrenamiento no califican una estrategia para señales comerciales o ejecución.

## 6. Experiencia de producto

La interfaz debe sentirse como un observatorio nocturno, no como una mesa de casino:

- densidad de información con jerarquía clara y lenguaje preciso;
- modo de ejecución visible en toda pantalla: `shadow`, `demo` o `real`, junto a un estado operativo separado como `healthy`, `degraded` o `paused`;
- confirmaciones explícitas y reautenticación para cambios de riesgo o ejecución;
- señales con símbolo, condición, evidencia, hora, vencimiento, estrategia y política aplicable;
- avisos claros de riesgo y estado de conectividad antes de acciones sensibles;
- color, icono y texto para estados críticos; sin animaciones que induzcan urgencia.

## 7. Plataformas

- **Web:** estación principal de investigación, auditoría, configuración de estrategias y administración de políticas.
- **Android:** aplicación de señales, supervisión y autorizaciones; una superposición opcional será de consulta pasiva y nunca controlará operaciones.
- **iOS:** aplicación React Native normal con alertas, widgets/Live Activities cuando sean apropiados y flujos seguros de autorización; no se promete una superposición global entre aplicaciones.
- **Windows:** cliente Tauri posterior, enfocado en estación de trabajo, sin duplicar el servidor de ejecución.

La documentación Android describe `TYPE_APPLICATION_OVERLAY` como una capa sobre ventanas de actividad, con restricciones de confianza e interacción. Por ello, cualquier capa futura de buoh se limita a consulta, es apagable y queda aislada de ejecución. [Referencia oficial](https://developer.android.com/reference/android/view/WindowManager.LayoutParams)

## 8. Criterios de éxito antes de operar dinero real

1. un experimento se reconstruye de forma idéntica desde datos y versión fijados;
2. el bot *shadow* tiene historial completo y sus decisiones pueden explicarse sin datos posteriores;
3. la estrategia supera el protocolo definido de validación fuera de muestra y comparación de línea base;
4. las pruebas demo reconcilian cada orden, reintento, cancelación, posición y desconexión;
5. la política de riesgo bloquea automáticamente casos prohibidos y el *kill switch* se verifica;
6. credenciales, autorizaciones y auditoría superan revisión de seguridad;
7. se ha completado la revisión de cumplimiento aplicable al modelo comercial y las jurisdicciones de lanzamiento.

## 9. Preguntas de dirección que permanecen

La dirección de público ya está resuelta: **uso propio primero, suscriptores externos después**. Las preguntas que aún bloquean un lanzamiento externo o real son:

- ¿En qué país se constituirá y se ofrecerá buoh inicialmente?
- ¿Qué instrumentos y tipos de contrato de Deriv formarán el universo inicial?
- ¿Quién define y aprueba los límites de riesgo de cada usuario y estrategia?
- ¿Cuál será la política de retención de datos, incidentes y soporte?
- ¿Qué modelo de suscripción y restricciones de acceso serán viables para el primer mercado?

No necesitamos estas respuestas para construir el laboratorio, el bot *shadow* ni la arquitectura de suscripciones. Sí son obligatorias antes de abrir pagos o dinero real a terceros.
