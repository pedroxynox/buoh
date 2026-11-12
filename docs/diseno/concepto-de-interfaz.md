# Concepto de interfaz de buoh

Diseño de la información del cliente web (`V1-UI-001`). El prototipo de `apps/web` lo implementa con datos ficticios; las fases 2 a 6 lo convierten en producto con datos reales. Marca y colores: [guía de marca](marca-buoh.md). Funciones y fases: [catálogo](../producto/funciones-y-disponibilidad.md).

## 1. Principios

1. **Un observatorio, no un casino.** La pantalla invita a mirar con calma: mucha información ordenada, nada que parpadee.
2. **Modo y salud siempre a la vista.** La barra superior muestra el modo de ejecución y la salud del servicio en todas las pantallas, como dos insignias distintas con texto e icono. Toda vista de datos muestra además símbolo, fuente, zona horaria (UTC), intervalo, frescura y calidad, como pide el [README](../../README.md#identidad-de-diseño).
3. **La evidencia a un clic.** Toda cifra de desempeño lleva su contexto completo al lado (modo, período, muestra, costes, pérdidas, *drawdown*, versión y limitaciones); toda señal enlaza a su evidencia.
4. **Nada se oculta.** Huecos, retrasos, pausas y pérdidas aparecen en el mismo nivel que lo bueno.
5. **Detener siempre está a mano; operar nunca.** El *kill switch* es visible; ningún botón del cliente envía órdenes.
6. **Lo futuro se ve como futuro.** Lo de la Fase 3B en adelante aparece con la etiqueta «Disponible en Fase N» y sin controles activos (corte del prototipo en §2).

## 2. Estructura

```text
┌───────────────────────────────────────────────────────────────────┐
│ buoh   [Datos ficticios]          Modo: SHADOW   Salud: Saludable │  barra superior
├──────────────┬────────────────────────────────────────────────────┤
│ Observatorio │                                                    │
│ Mercados     │   título de la sección + resumen en una frase      │
│ Datos        │                                                    │
│ Laboratorio  │   tarjetas y tablas de la sección                  │
│ Señales      │                                                    │
│ Ejecución  4 │                                                    │
│ Riesgo     4 │                                                    │
│ Auditoría    │                                                    │
│ Conexiones   │                                                    │
│ Guía visual  │                                                    │
└──────────────┴────────────────────────────────────────────────────┘
```

- La navegación lateral marca con el número de fase las secciones cuya función entera empieza en Fase 4 o después (Ejecución y Riesgo). Conexiones y Auditoría se dibujan, y dentro bloquean solo sus partes de Fase 4.
- **Corte del prototipo:** las funciones de las fases 1, 1B, 2 y 3 se dibujan con datos ficticios; las de la Fase 3B en adelante aparecen con el candado de fase y, como mucho, una vista previa sin controles.
- Por debajo de 960 px, la navegación pasa a una barra inferior con Observatorio (rotulado «Inicio»), Mercados, Laboratorio, Señales y un menú «Más» con las demás secciones. Esa forma anticipa la app móvil.
- La marca «Datos ficticios» solo existe en el prototipo y no se puede ocultar. En la web servida por la API va solo en las secciones que siguen con datos ficticios (§10).

## 3. Secciones

| Ruta | Sección | Qué responde | Fase real |
|---|---|---|---|
| `/` | Observatorio | ¿Está todo bien ahora? Salud, modo, alertas abiertas, últimas señales y último dataset | 2 |
| `/mercados` | Mercados | ¿Qué instrumentos sigo y qué tan buenos son sus datos? Catálogo por fuente y gráfico con huecos marcados | 2 (Deriv), 1B (MT5) |
| `/datos` | Datos | ¿Puedo confiar en estos datos? Datasets publicados, verificación e incidencias de calidad | 2 |
| `/laboratorio` | Laboratorio | ¿Esta estrategia tiene evidencia? Versiones, backtest y validación fuera de muestra | 2 |
| `/senales` | Señales | ¿Qué propuso el bot y con qué evidencia? Registro con modo, vencimiento y calidad | 2 |
| `/ejecucion` | Ejecución | ¿Qué pidió la pasarela y qué respondió el bróker? Intenciones, órdenes y reconciliación | 4 |
| `/riesgo` | Riesgo | ¿Qué límites protegen cada estrategia? Políticas y *kill switch* | 4 |
| `/auditoria` | Auditoría | ¿Qué pasó, cuándo y quién? Registro inmutable | 2 y 4 |
| `/conexiones` | Conexiones | ¿Están conectadas mis fuentes? Deriv, puente MT5 y autorizaciones | 1B y 4 |
| `/guia` | Guía visual | Colores, tipografía, estados y componentes de la marca | V1 |

## 4. Componentes clave

| Componente | Regla |
|---|---|
| Insignia de modo | `disabled`, `shadow`, `demo` o `real`, con icono y descripción corta («dinero de práctica», «dinero real») |
| Insignia de salud | Los seis estados del contrato, con icono y texto; tonos e iconos distintos de los del modo, salvo el neutro de pausa ([guía](marca-buoh.md) §5). Cuando la web no sabe el estado, una insignia neutra, sin tono, que dice por qué; nunca uno de los seis inventado (§10) |
| Etiqueta de severidad | `info`, `warning`, `error`, `critical` |
| Métrica con contexto | No se puede mostrar una cifra de desempeño sin su bloque de contexto; su origen es `backtest`, `shadow`, `demo` o `real` |
| Tarjeta de señal | Estrategia y versión, símbolo, condición, emisión, vencimiento, modo, calidad y enlace a evidencia |
| Candado de fase | «Disponible en Fase N» y una frase de qué hará; sin botones activos |
| Gráfico de precios | Línea fina o velas; los huecos se dibujan como cortes con una marca y su motivo; su alternativa, en texto o en tabla, se calcula de los datos (§9) |
| *Kill switch* | Visible y explicado; en el prototipo, inactivo hasta Fase 4 |
| Aviso de datos ficticios | Fijo en la barra superior del prototipo; en la web servida por la API, solo en las secciones que siguen con datos ficticios (§10) |

## 5. Estados de pantalla

- **Cargando:** esqueletos discretos, sin animación si el sistema pide reducir movimiento.
- **Vacío:** una frase de por qué está vacío y qué hacer.
- **Error:** qué falló, desde cuándo y si los datos mostrados siguen siendo válidos.
- **Degradado:** la insignia de salud cambia y las cifras afectadas muestran una marca de calidad.

## 6. Prototipo implementado (V1.2)

`apps/web` implementa las diez secciones de §3 y una página 404, todas con el marco de §2. Detalles:

- Los datos viven en `packages/prototype-data`, compartidos con el prototipo móvil, fijados a mano o calculados con fórmulas fijas; el instante de referencia es el 20 oct 2026, 14:32:05 UTC.
- Cuentan una historia coherente, comprobada por pruebas: Deriv perdió la conexión, R_100 quedó con un hueco sin resolver, Deriv y la salud global están degradadas y la estrategia que usa R_100 se pausó sola. Solo emite señales vigentes una estrategia aprobada para shadow, y solo después de su aprobación.
- Supuestos del prototipo, que el contrato todavía no fija: la salud global es la más severa de sus fuentes, y una pausa automática afecta solo a las estrategias del símbolo con datos degradados.
- Los gráficos son SVG propios: el de precios corta la línea en los huecos y los rotula; el de resultados marca el cero y la peor caída, en % del capital inicial. Sus textos van en HTML para leerse igual en móvil, con eje de tiempo, y su alternativa en texto se calcula de los datos (§9). Su recorrido completo, de los datos a la pantalla, está en [flujo de gráficos](flujo-de-graficas.md).
- El ejemplo del laboratorio es deliberadamente honesto: la estrategia gana en entrenamiento y pierde fuera de muestra, así que no pasa la validación y se retira sin llegar a shadow.
- Las únicas acciones son enlaces de navegación. Los botones de las secciones de Fase 4 están desactivados, y los de la guía visual son muestras sin efecto.
- La guía visual dibuja también los estados de pantalla de §5: cargando, vacío, error y degradado.

Construcción y revisión:

```text
pnpm --filter @buoh/web run build              # exporta a apps/web/out
pnpm --filter @buoh/web run test               # comprueba cada página exportada
pnpm --filter @buoh/prototype-data run test    # comprueba la coherencia de los datos ficticios
```

`apps/web/out` es un sitio estático: se puede abrir con cualquier servidor de archivos local. No se publica en internet: `render.yaml` solo define el sitio oficial (ADR-0013).

## 7. Hacia móvil y escritorio

- **Móvil:** Observatorio, Señales, Alertas, Evidencia y *kill switch*, con la barra inferior de §2. Sin edición de estrategias ni de políticas, y sin abrir operaciones a mano. Es un control remoto del bot: desde la Fase 4 lo detiene y vuelve a encender una estrategia detenida, y desde la Fase 6 también pide el modo real, con las mismas reglas que la web ([catálogo](../producto/funciones-y-disponibilidad.md) §1). El prototipo de `apps/mobile` (V1.4, [ADR-0009](../arquitectura/adr/0009-prototipo-movil.md)) lo implementa con cinco pestañas: Inicio, Señales, Alertas, Evidencia y Más; el *kill switch* está en «Más», con candado de Fase 4. Volver a encender una estrategia no aparece en el prototipo, que se cerró con V1 antes de esa decisión.
- **Escritorio:** la misma estructura que la web, con ventanas que se pueden separar para seguir varios mercados. El prototipo de `apps/desktop` (V1.5, [ADR-0010](../arquitectura/adr/0010-prototipo-de-escritorio.md)) muestra la web en una ventana de Windows; las ventanas separables llegan con la app real.

Ambos usan los mismos tokens de `packages/design-system`.

## 8. La web servida por la API (F2.3)

Desde la Fase 2 (F2.3), `apps/web` se exporta en dos variantes del mismo código, que elige una variable de compilación ([ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §9):

- `apps/web/out`: el prototipo del escritorio de §7, con datos ficticios, sin formularios y sin llamar a la API. No incluye las pantallas de acceso ni de enlace.
- `apps/web/out-api`: la que sirve la API. Añade, sobre la misma estructura de §2 y la misma línea visual, estas pantallas nuevas:
  - **Inicio de sesión** (`/acceso`): usuario, contraseña y un código de 6 cifras en un solo formulario, con los atributos que esperan los gestores de contraseñas. Ante cualquier dato incorrecto, el mismo mensaje, sin decir cuál falló.
  - **Enlace de alta** (`/enlace`): lee el token del fragmento de la dirección, muestra el QR del secreto y su texto, y pide la contraseña nueva y un código para terminar el alta o el restablecimiento. buoh nunca envía enlaces para entrar.
  - **Menú de la sesión** en la barra superior: cerrar la sesión y cerrar las demás.
  - **Auditoría** (`/auditoria`): sus eventos son reales, los de la cuenta, que pide a la API al abrir la página (ADR-0019 §5); las órdenes siguen con el candado de Fase 4.

La sección de Auditoría fue la primera con datos reales (F2.3). Desde F2.4 lo son también el Observatorio y las insignias de modo y salud de la barra superior (§10), y las demás secciones los traen con sus entregas de F2.4. Mientras tanto, `out-api` conserva en ellas la marca «Datos ficticios». Los formularios usan los campos del sistema de diseño (`b-field`, `b-input`); el QR se dibuja dentro de buoh, sin recursos de terceros; y la propia API sirve la web con su política de contenido (ADR-0019 §9). Cada fallo de la API se lee con un texto fijo según su código, nunca con el mensaje del servidor (`apps/web/src/components/auth/api.ts`). Desde F2.4, el de `storage_unavailable`, cuando el almacenamiento de los datos no responde (ADR-0019 §8), dice «El almacenamiento de los datos no responde ahora mismo. Inténtalo de nuevo en un momento.».

## 9. Gráficos (F2.4)

Reglas de los gráficos antes de que muestren datos reales (`F2-CHART-001` del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md), que resuelve P-V1-04 de la [especificación de pendientes](../plan/especificacion-de-pendientes.md)). Valen en la web, en el escritorio, que la muestra, y en el móvil cuando tenga gráficos. Cómo están hechos hoy: [flujo de gráficos](flujo-de-graficas.md).

- **Qué se dibuja.** El eje horizontal es el tiempo UTC, así que un hueco ocupa lo que duró. Un hueco es el período que los datos marcan como tal, con su motivo: el de la incidencia o la condición que lo registra, como `event_gap_unresolved`, que da su rango de tiempo y su motivo ([contratos de dominio](../arquitectura/contratos-de-dominio.md)). El gráfico no lo deduce de la distancia entre dos ticks, no lo rellena ni lo suaviza, y corta la línea en él. Los ticks que faltan solo se cuentan si la fuente tiene una cadencia fija, como R_100. Un tick sin vecinos, entre dos huecos, se dibuja como un punto.
- **Alternativa.** Cada gráfico tiene la suya, calculada de los mismos datos que dibuja, nunca escrita a mano. Si es un texto, es el nombre del gráfico para el lector de pantalla (`role="img"`); si es una tabla, va junto al gráfico:
  - el de ticks, en texto: qué es, su período UTC, cuántos ticks tiene, el primero y el último, el mínimo y el máximo, y cada hueco, con su período, su motivo y, si se cuentan, los ticks que faltan;
  - el de velas, en tabla: una fila por vela, con su inicio UTC, la apertura, el máximo, el mínimo, el cierre, sus ticks y, si la toca un hueco, su motivo;
  - la curva de resultados, en texto: qué es y en qué unidad, su período, el primer y el último valor, el máximo, el mínimo y la peor caída, con el máximo del que parte y su valle.
- **Contraste.** La línea y el hueco son las partes que hacen falta para entender un gráfico, así que miden al menos 3:1 sobre todos los fondos de los dos temas (WCAG 2.2, criterio 1.4.11). La nota del hueco es texto y mide al menos 4,5:1. La rejilla es decorativa: no lleva información, porque los valores se leen en las cifras del eje y en la alternativa, y con la paleta de hoy no llega a 3:1. La línea de cero y la marca de la peor caída usan colores de texto, con su contraste. Lo comprueba `packages/design-system/test/tokens.test.ts`.
- **Peor caída.** Una curva de resultados mide el resultado acumulado en % del capital inicial, hipotético mientras no haya ejecución. Su peor caída es la mayor bajada desde un máximo anterior, en esa misma unidad y con signo menos, por ejemplo «−3,6 %». Se escribe igual en la nota del gráfico, en su alternativa y en la tarjeta de contexto, nunca en puntos ni como porcentaje del máximo.
- **Velas.** Cada vela resume los ticks de un intervalo fijo, alineado en UTC a su múltiplo (las de 5 minutos empiezan a las :00, a las :05…), por la hora de la fuente de cada tick: apertura, máximo, mínimo, cierre y número de ticks.
  - **Intervalo.** El menor de 1, 5, 15 y 60 minutos con el que la ventana dura como mucho 120 intervalos: 1 minuto hasta 2 horas, 5 hasta 10, 15 hasta 30 y 60 por encima, aunque entonces haya más de 120 velas. Como cada vela se alinea a su múltiplo, la primera y la última pueden cubrir solo parte de su intervalo, y la ventana toca como mucho una vela más.
  - **Dirección.** Una vela que sube y una que baja se distinguen por su forma, no por el color (guía de marca §5 y §10): todas usan el color de la línea, la que sube con el cuerpo hueco y la que baja con el cuerpo lleno, y una que cierra igual que abre, como la que sube; su cuerpo y su mecha miden lo mismo que la línea, 3:1 o más.
  - **Huecos.** Una vela cuyo intervalo toca un hueco se dibuja con el borde discontinuo del color del hueco, y su fila la marca como incompleta. Un intervalo sin ningún tick no tiene vela: si lo marca un hueco, lo cubre su banda, con su motivo; si no, como con el mercado cerrado de una fuente con horario (Fase 1B), queda vacío. Nunca se dibuja una vela con el cierre de la anterior.
- **Estados (§5).** Sin ningún tick, o con todos los del período dentro de un hueco, el gráfico no se dibuja: en su lugar se lee su alternativa, que dice por qué, con los huecos y su motivo. Qué hacer lo dicen la salud y la calidad de la misma vista (§1). Una curva de resultados sin valores dice que todavía no hay resultados.
- **Pruebas.** `apps/web/test/charts.test.tsx` prueba la escala, los cortes de la línea, la banda de cada hueco, el SVG y la alternativa, también con una serie vacía, una sin ningún dato y un hueco en el primer punto. `apps/web/test/export.test.ts` comprueba lo que muestran las páginas exportadas. Los gráficos con datos reales, con su eje en el tiempo y sus velas, los prueba `apps/web/test/mercados.test.tsx` (§11).

## 10. Observatorio y barra superior con datos reales (F2.4)

En `apps/web/out-api`, el Observatorio y las insignias de modo y salud de la barra superior muestran los datos de producción (`F2-UI-001` del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md)). `apps/web/out`, el prototipo del escritorio, no cambia: sigue con los datos ficticios y sin llamar a la API.

- **De dónde salen.** La salud es la de `GET /api/v1/datos/salud` (`DataHealth`, [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8): la última observación que guardó `buoh-operaciones` en el log activo, con su hora. La barra superior y el Observatorio leen la misma respuesta. La web la pide al abrirse, después cada minuto mientras la pestaña está a la vista y al volver a ella. Esas lecturas van sin el token CSRF: son la actualización automática, que no renueva la inactividad de la sesión (ADR-0019 §2). Lo que recibe el navegador se comprueba antes de dibujarlo, con las reglas del contrato: una respuesta sin la forma de `DataHealth` es un error, nunca un estado.
- **Modo.** `disabled`, «Desactivado»: hasta F2.9 no existe ningún componente que emita señales. No sale de la salud, porque son ejes distintos y el modo no desaparece cuando la salud no se puede leer. El `HealthReport` dice lo mismo: su `execution_mode` solo admite `disabled`. Desde F2.9 lo da el motor de señales.
- **Salud.** La insignia es el `service_health` del informe. Cuando la web no lo sabe, la insignia es neutra, sin tono de estado, y dice por qué: «Leyendo…» mientras llega la respuesta, «Sin sesión», «No disponible» si la API falla, y «Sin observar» si no hay log activo, si el log todavía no tiene observaciones, como justo después del corte semanal, o si la última falló. Una observación de hace más de 15 minutos, el triple de la cadencia de `buoh-operaciones` (ADR-0018 §11), conserva su estado y suma la marca «Antigua».
- **Causa.** Se lee del informe, sin inventarla, en este orden: las alertas de `data:health` que cambian la salud, cada condición abierta, la de `recovering` sin `connection_lost` y la cola sobre su límite. Cada una impone su gravedad, como en el dominio ([contratos de dominio](../arquitectura/contratos-de-dominio.md), «HealthReport»), y si ninguna llega a la del estado se suma la del propio estado: un `paused` con causas menores, como una `connection_lost`, solo lo da que no haya un proceso que capture con un latido reciente. En `recovering` sin `connection_lost`, la conexión decide: con `connected`, falta la continuidad, aunque `open_condition_types` esté vacío (pendiente 2 de F1.2); sin ella, la captura está volviendo a conectar, o cerró la conexión a pedido con la continuidad todavía pendiente, y el informe no distingue las dos. Los avisos que no cambian la salud, como un punto de control descartado, van aparte de la causa. Una alerta o un motivo que la web no conoce se muestran con su código.

  | En el informe | Lo que dice la vista |
  |---|---|
  | una alerta de `data:health` que cambia la salud | «Log incompatible», con lo incompatible en palabras; «Error de la observación»; «Log sin preparar»; «Migraciones pendientes»; «Almacenes sin respuesta»; «Reconstrucción sin terminar» |
  | un aviso de `data:health` | aparte de la causa: «Punto de control descartado», «Punto de control sin leer» o, si la web no lo conoce, su código |
  | una condición abierta | «Conexión perdida», «Hueco sin resolver», «Persistencia no disponible» o «Límite de fuente superado» |
  | `recovering` sin `connection_lost` ni `connected` | «Sin conexión con Deriv»: vuelve a conectar, o cerró la conexión a pedido con la continuidad pendiente |
  | `recovering` sin `connection_lost`, con `connected` | «Continuidad pendiente» |
  | más de 1000 eventos o de 32 MiB en la cola (ADR-0004 §7) | «Cola sobre su límite» |
  | `paused` con causas que no llegan a esa gravedad | «Sin captura activa»: no hay un proceso que capture con un latido reciente |
  | `starting`, `paused` o `failed` sin ninguna causa | «Sin datos todavía»; «Entrada detenida»: se paró a pedido, o no hay un proceso que capture con un latido reciente; «Log incompatible» |
  | una observación fallida | «Observación fallida», con su motivo |
  | una observación de hace más de 15 minutos | «Observación antigua» |

- **Metadatos.** Como toda vista de datos (§1): el símbolo, R_100, el que observa `data:health` y el único de la Fase 2; la fuente; la zona horaria, UTC; el intervalo, una observación cada 5 minutos; la frescura, con la hora de la observación y su edad; y la calidad, con los tipos de condición abiertos, que es lo que trae el informe. Además, el log activo, la conexión, el último mensaje recibido, el último tick y la cola sin guardar.
- **Último dataset.** El `last_published_dataset_id` del informe. Hasta F2.5 no hay ninguno, y la tarjeta lo dice.
- **Lo que todavía no existe.** Las estrategias en shadow y las señales muestran su estado vacío, con su porqué, y el kill switch conserva su candado de Fase 4. Sin informe, el último dataset y las condiciones dicen por qué: leyendo, la salud no se pudo leer, todavía no hay ninguna observación o la última falló. El Observatorio de `out-api` no muestra ningún dato ficticio, así que no lleva la marca.
- **Estados (§5).** Cargando: un esqueleto quieto. Vacío: sin log o sin observaciones, con su porqué. Error: qué falló y, sin sesión, el enlace para iniciarla; si falla una actualización después de una buena, lo dice y conserva la anterior, con su hora. Degradado: la insignia cambia y la causa lo explica.
- **La marca «Datos ficticios».** En `out-api` va en la barra superior solo en las secciones que siguen con datos ficticios: no en el Observatorio, en Mercados (§11) ni en la Auditoría, que muestran datos reales, ni en el inicio de sesión ni en el enlace, que no muestran datos. Cada sección dice en la navegación (`realInApi`, en `apps/web/src/navigation.ts`) cuándo pasa a datos reales. Una ruta que no existe, la del 404, la lleva.
- **Pruebas.** `apps/web/test/salud.test.ts` comprueba la forma de la respuesta contra el contrato, la causa de cada estado, la frescura, el refresco y la marca de cada sección, y compara la lectura de la causa, con su gravedad, con la derivación real del dominio (`deriveLiveHealthReport`) en todas las combinaciones de sus entradas, y la gravedad de cada alerta con la evaluación real de `data:health` del worker (`evaluateDataHealth`). `apps/web/test/observatorio.test.tsx` dibuja el Observatorio y la insignia, y `apps/web/test/out-api.test.ts` comprueba la exportación.

## 11. Mercados con datos reales (F2.4)

En `apps/web/out-api`, Mercados muestra el gráfico de R_100 y el catálogo de Deriv de producción (`F2-UI-001` del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md)). `apps/web/out`, el escritorio, no cambia: sigue con los datos ficticios y sin llamar a la API.

- **De dónde salen.** El gráfico es el de `GET /api/v1/datos/grafico?hours=<n>` (`DataChart`, [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8), y el catálogo, el de `GET /api/v1/datos/catalogo` (`DataCatalog`). Como la salud (§10), van sin el token CSRF y se comprueban en el navegador con las reglas del contrato antes de dibujarse. Una respuesta sin su forma, o de otra ventana, es un error.
- **Ventana y refresco.** La página se abre con la última hora, como decidió el propietario el 2026-11-05 (`PROJECT_STATUS.md`, «Decisiones vigentes relevantes»), y se puede elegir 1, 6 o 24 horas, la máxima de los contratos. El gráfico se vuelve a pedir cada minuto con la de 1 hora y cada 5 minutos con las de 6 y 24, mientras la pestaña está a la vista, y al volver a ella. El catálogo se pide al abrir la página y después, con el gráfico, cada 30 minutos.
- **Tráfico de salida.** La API no comprime sus respuestas, pero llegan comprimidas al navegador: Cloudflare, delante de Render, las envía con Brotli cuando el navegador lo admite, como hacen todos ([evidencia de F2.4](../operacion/evidencia-datos-f2-4.md), «La compresión de las respuestas de `buoh-api`»). Sin comprimir, con la página abierta, el gráfico son unos 1,7 MB por hora con la ventana de 1 hora, unos 2,4 MB con la de 6 y unos 9,7 MB con la de 24; comprimido, de 6 a 8 veces menos (estimación con datos sintéticos). A eso se suman las lecturas de R2 de la API, las mismas con cualquier ventana, porque solo lee lo nuevo: dos peticiones por cada evento nuevo de la captura y por cada segmento que se cierra, unas 60 por minuto con la página abierta, de alrededor de 1 KB de tráfico de salida cada una ([ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md) §13). Cuánto cuenta Render de verdad lo mide el punto 7 de F2.4 (ADR-0019 §8).
- **Ticks.** El eje horizontal es el tiempo UTC de la ventana, y cada tick va en su hora de fuente. La línea une cada tick con el siguiente salvo si entre los dos empieza un hueco del log: nunca se corta por la distancia entre dos ticks. Los ticks que recuperó la historia todavía no se dibujan ([ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §4).
- **Velas.** Las de §9: el intervalo según la ventana (1 minuto con 1 hora, 5 con 6 y 15 con 24), alineadas en UTC, la que sube hueca y la que baja llena, y la que toca un hueco con el borde discontinuo del color del hueco. Su tabla va junto al gráfico, plegada, con una fila por vela.
- **Huecos.** Cada hueco del log es una banda del color del hueco, y debajo del gráfico va su lista, con su período y lo que pasó.

  | En la respuesta | Lo que dice la vista |
  |---|---|
  | `capture_stopped` | «Captura parada»: como en un despliegue o un reinicio, y no se recupera |
  | `connection_lost` con `recovered` | «Conexión perdida, recuperada», con los ticks que trajo la historia |
  | `connection_lost` con `partial` o `unavailable` | «Conexión perdida, sin recuperar», con su motivo |
  | `connection_lost` con `pending` | «Conexión perdida, pendiente»: la historia todavía no llegó |
  | un hueco sin `to_utc` | su período termina en «y sigue» |

- **Metadatos.** Los de §1: el símbolo y la fuente de la respuesta; la zona horaria, UTC; el intervalo, cada tick o el de las velas; el período de la ventana; la frescura, con la hora del último tick y la de la lectura; y la calidad, con cuántos huecos hay y cuántos siguen sin recuperar. Además, el log activo y, si empezó dentro de la ventana, desde cuándo tiene datos.
- **Catálogo.** La última versión del log activo, con su número, la hora en que llegó, la release de esquemas y su `content_sha256`, y una tabla de los instrumentos con sus nombres oficiales, sin reinterpretar: el símbolo, el nombre, el tipo, el mercado, el submercado, el grupo, el tamaño del pip y si está abierto, cerrado o suspendido. La fila de R_100 dice que se captura. Si el log todavía no tiene ninguna versión, como justo después del corte semanal, lo dice.
- **Estados (§5).** Cargando: un esqueleto quieto. Vacío: sin log activo, o sin ningún tick en la ventana, cuando se lee la alternativa con los huecos. Error: qué falló y, sin sesión, el enlace para iniciarla; si falla una actualización después de una buena, lo dice y conserva la anterior, con su hora. Degradado: la insignia de calidad cuenta los huecos sin recuperar.
- **Lo que todavía no existe.** Las demás fuentes: en la Fase 2 solo se captura R_100 de Deriv, y la página lo dice, sin las tarjetas de fuentes ficticias del escritorio.
- **Pruebas.** `apps/web/test/mercados.test.tsx` contrasta la comprobación de las dos respuestas con los esquemas de `@buoh/contracts`, también en miles de respuestas cambiadas al azar, y prueba la línea, las bandas, las velas, sus alternativas, la vista en cada estado, el almacén con su refresco y las dos lecturas sin el token CSRF. `apps/web/test/out-api.test.ts` comprueba la exportación.
