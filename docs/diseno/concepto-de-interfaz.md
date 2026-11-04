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
- La marca «Datos ficticios» solo existe en el prototipo y no se puede ocultar.

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
| Insignia de salud | Los seis estados del contrato, con icono y texto; tonos e iconos distintos de los del modo, salvo el neutro de pausa ([guía](marca-buoh.md) §5) |
| Etiqueta de severidad | `info`, `warning`, `error`, `critical` |
| Métrica con contexto | No se puede mostrar una cifra de desempeño sin su bloque de contexto; su origen es `backtest`, `shadow`, `demo` o `real` |
| Tarjeta de señal | Estrategia y versión, símbolo, condición, emisión, vencimiento, modo, calidad y enlace a evidencia |
| Candado de fase | «Disponible en Fase N» y una frase de qué hará; sin botones activos |
| Gráfico de precios | Línea fina; los huecos se dibujan como cortes con una marca y su motivo; su alternativa en texto se calcula de los datos (§9) |
| *Kill switch* | Visible y explicado; en el prototipo, inactivo hasta Fase 4 |
| Aviso de datos ficticios | Fijo en la barra superior del prototipo |

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

La sección de Auditoría es la primera con datos reales (F2.3); las demás secciones los traen en F2.4. Hasta entonces, `out-api` conserva en ellas la marca «Datos ficticios» y las insignias de modo y salud de la barra superior, como el prototipo. Los formularios usan los campos del sistema de diseño (`b-field`, `b-input`); el QR se dibuja dentro de buoh, sin recursos de terceros; y la propia API sirve la web con su política de contenido (ADR-0019 §9).

## 9. Gráficos (F2.4)

Reglas de los gráficos antes de que muestren datos reales (`F2-CHART-001` del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md), que resuelve P-V1-04 de la [especificación de pendientes](../plan/especificacion-de-pendientes.md)). Valen en la web, en el escritorio, que la muestra, y en el móvil cuando tenga gráficos. Cómo están hechos hoy: [flujo de gráficos](flujo-de-graficas.md).

- **Qué se dibuja.** El eje horizontal es el tiempo UTC, así que un hueco ocupa lo que duró. Un hueco es el período que los datos marcan como tal, con su motivo: el gráfico no lo deduce de la distancia entre dos ticks, no lo rellena ni lo suaviza, y corta la línea en él. Un tick sin vecinos, entre dos huecos, se dibuja como un punto.
- **Alternativa.** Cada gráfico tiene la suya, calculada de los mismos datos que dibuja, nunca escrita a mano. Si es un texto, es el nombre del gráfico para el lector de pantalla (`role="img"`); si es una tabla, va junto al gráfico:
  - el de ticks, en texto: qué es, su período UTC, cuántos ticks tiene, el mínimo, el máximo, el último y cada hueco, con los ticks que faltan, su período y su motivo;
  - el de velas, en tabla: una fila por vela, con su inicio UTC, la apertura, el máximo, el mínimo, el cierre, sus ticks y, si la toca un hueco, su motivo;
  - la curva de resultados, en texto: qué es y en qué unidad, su período, el primer y el último valor, el máximo, el mínimo y la peor caída, con el máximo del que parte y su valle.
- **Contraste.** La línea y el hueco son las partes que hacen falta para entender un gráfico, así que miden al menos 3:1 sobre todos los fondos de los dos temas (WCAG 2.2, criterio 1.4.11). La nota del hueco es texto y mide al menos 4,5:1. La rejilla es decorativa: no lleva información, porque los valores se leen en las cifras del eje y en la alternativa, y con la paleta de hoy no llega a 3:1. La línea de cero y la marca de la peor caída usan colores de texto, con su contraste. Lo comprueba `packages/design-system/test/tokens.test.ts`.
- **Peor caída.** Una curva de resultados mide el resultado acumulado en % del capital inicial, hipotético mientras no haya ejecución. Su peor caída es la mayor bajada desde un máximo anterior, en esa misma unidad y con signo menos, por ejemplo «−3,6 %». Se escribe igual en la nota del gráfico, en su alternativa y en la tarjeta de contexto, nunca en puntos ni como porcentaje del máximo.
- **Velas.** Cada vela resume los ticks de un intervalo fijo, alineado en UTC a su múltiplo (las de 5 minutos empiezan a las :00, a las :05…), por la hora de la fuente de cada tick: apertura, máximo, mínimo, cierre y número de ticks. El intervalo es el menor de 1, 5, 15 y 60 minutos que deja como mucho 120 velas en la ventana: 1 minuto hasta 2 horas, 5 hasta 10 horas, 15 hasta 30 horas y 60 por encima. Una vela cuyo intervalo toca un hueco se dibuja con el borde discontinuo del color del hueco, y su fila la marca como incompleta. Un intervalo sin ningún tick no tiene vela: lo cubre la banda del hueco, con su motivo. Nunca se dibuja una vela con el cierre de la anterior.
- **Estados (§5).** Sin ningún tick, o con todos los del período dentro de un hueco, el gráfico no se dibuja: en su lugar se lee su alternativa, que lo dice, con los huecos y su motivo. Una curva de resultados sin valores dice que todavía no hay resultados.
- **Pruebas.** `apps/web/test/charts.test.tsx` prueba la escala, los cortes de la línea, la banda de cada hueco, el SVG y la alternativa, también con una serie vacía, una sin ningún dato y un hueco en el primer punto. `apps/web/test/export.test.ts` comprueba lo que muestran las páginas exportadas.
