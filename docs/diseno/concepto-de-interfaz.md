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
| Gráfico de precios | Línea fina; los huecos se dibujan como cortes con una marca y su motivo |
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
- Los gráficos son SVG propios: el de precios corta la línea en los huecos y los rotula; el de resultados marca el cero y la peor caída. Sus textos van en HTML para leerse igual en móvil, con eje de tiempo.
- El ejemplo del laboratorio es deliberadamente honesto: la estrategia gana en entrenamiento y pierde fuera de muestra, así que no pasa la validación y se retira sin llegar a shadow.
- Las únicas acciones son enlaces de navegación. Los botones de las secciones de Fase 4 están desactivados, y los de la guía visual son muestras sin efecto.
- La guía visual dibuja también los estados de pantalla de §5: cargando, vacío, error y degradado.

Construcción y revisión:

```text
pnpm --filter @buoh/web run build              # exporta a apps/web/out
pnpm --filter @buoh/web run test               # comprueba cada página exportada
pnpm --filter @buoh/prototype-data run test    # comprueba la coherencia de los datos ficticios
```

`apps/web/out` es un sitio estático: se puede abrir con cualquier servidor de archivos local. No se publica en internet (ADR-0008 §3).

## 7. Hacia móvil y escritorio

- **Móvil:** Observatorio, Señales, Alertas, Evidencia y *kill switch*, con la barra inferior de §2. Sin edición de estrategias ni de políticas. El prototipo de `apps/mobile` (V1.4, [ADR-0009](../arquitectura/adr/0009-prototipo-movil.md)) lo implementa con cinco pestañas: Inicio, Señales, Alertas, Evidencia y Más; el *kill switch* está en «Más», con candado de Fase 4.
- **Escritorio:** la misma estructura que la web, con ventanas que se pueden separar para seguir varios mercados.

Ambos usan los mismos tokens de `packages/design-system`.
