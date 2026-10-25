# Guía de marca de buoh

Fuente canónica de la identidad visual (`V1-BRAND-001`). Los valores exactos viven en [`packages/design-system`](../../packages/design-system/README.md); si esta guía y los tokens difieren, se corrige la guía o se versionan los tokens en el mismo PR.

## 1. Idea

buoh viene de **búho**: un ave que observa de noche, con paciencia, y actúa solo cuando ve con claridad. La marca transmite eso:

- **serena:** nada parpadea, nada apura;
- **precisa:** cada número dice de dónde viene y qué tan confiable es;
- **honesta:** muestra pérdidas, límites y dudas igual que los aciertos;
- **nocturna:** fondos profundos, luz de luna y dos ojos ámbar que miran.

Lema principal: **«Observa con calma. Decide con evidencia.»**

buoh **no** es un casino, ni una promesa de dinero fácil, ni una cuenta regresiva.

## 2. Nombre

- Siempre en minúsculas: **buoh**, también al inicio de una frase.
- No se traduce, no se separa y no lleva símbolos.
- En textos legales o formales se puede escribir «el sistema buoh».

## 3. Voz y tono

| Hacemos | Evitamos |
|---|---|
| Frases cortas y claras | Jerga sin explicar |
| Números con contexto: período, muestra, costes, modo | Un porcentaje suelto como prueba |
| Decir «no sabemos todavía» cuando es verdad | Garantías y certezas |
| Mostrar el estado real, aunque sea malo | Ocultar pausas, huecos o pérdidas |
| Invitar a revisar la evidencia | Presionar con urgencia |

Palabras y fórmulas **prohibidas** en cualquier pieza: «ganancia garantizada», «sin riesgo», «dinero fácil», «hazte rico», «señal segura», «última oportunidad», contadores regresivos de oferta y comparaciones con apuestas.

## 4. Logotipo

- **Símbolo:** cara de búho geométrica. Cabeza con dos penachos, ojos ámbar con pupila oscura y un pico pequeño. Está en `packages/design-system/assets/`.
- **Logotipo completo:** símbolo a la izquierda y la palabra **buoh** en Manrope 700, con espaciado de letras de −2 %.
- **Variantes:** completo, solo símbolo y monocromo (un solo color, para fondos donde el ámbar no tenga contraste).
- **Área de respeto:** alrededor del logotipo, un espacio libre igual al diámetro de un ojo.
- **Tamaño mínimo:** símbolo 16 px; logotipo completo 88 px de ancho.

No se permite: deformar, rotar, añadir sombras o brillos, cambiar el color de los ojos (salvo en la versión monocroma), colocarlo sobre fotos sin contraste o animarlo para llamar la atención.

## 5. Paleta

### Colores base

| Familia | Token | Valor | Uso |
|---|---|---|---|
| Noche | `noche.950` | `#060A12` | fondo hundido |
| | `noche.900` | `#0A101C` | fondo general |
| | `noche.850` | `#0E1626` | superficies |
| | `noche.800` | `#131D31` | superficies elevadas |
| | `noche.750` | `#1A2337` | fondo de insignias neutras |
| | `noche.700` | `#1A273F` | bordes suaves y estados *hover* |
| | `noche.600` | `#25344F` | bordes |
| | `noche.500` | `#63769A` | bordes fuertes de controles |
| Niebla | `niebla.50` | `#F4F6FB` | texto principal |
| | `niebla.200` | `#C8D0E2` | texto secundario |
| | `niebla.300` | `#A7B2CB` | estado en pausa o desactivado |
| | `niebla.400` | `#8D9AB6` | texto tenue |
| Luna | `luna.100` | `#F8F2E1` | acción principal (*hover*) |
| | `luna.200` | `#F0E5C6` | acción principal |
| Ámbar | `ambar.400` | `#F2B544` | ojos del búho y acento de marca |
| | `ambar.700` | `#8A5A00` | acento de marca sobre fondo claro |

Para el tema día se usa la familia **papel**:

| Token | Valor | Uso en tema día |
|---|---|---|
| `papel.0` | `#FFFFFF` | superficies y ojos del búho |
| `papel.50` | `#F5F6FA` | fondo general |
| `papel.100` | `#EEF1F7` | estados *hover* |
| `papel.150` | `#ECEFF5` | fondo hundido e insignias neutras |
| `papel.200` | `#E3E7F0` | bordes suaves |
| `papel.300` | `#CBD2E0` | bordes |
| `papel.500` | `#7D8AA3` | bordes fuertes de controles |
| `papel.600` | `#55627D` | texto tenue y tono niebla (pausa, desactivado, backtest) |
| `papel.700` | `#33415C` | texto secundario |

En tema día, el texto principal, la cabeza del búho y la acción principal usan `noche.850` (`#0E1626`), y la acción principal en *hover* usa `noche.700` (`#1A273F`).

Proporción orientativa en una pantalla: 70 % noche, 20 % niebla, 10 % luna y ámbar. El ámbar es el color de la marca: **no** se usa para estados, para que nunca se confunda con una alerta.

### Colores de estado

Un estado nunca se comunica solo con color: siempre lleva texto e icono.

| Tono | Tema noche | Tema día | Se usa para |
|---|---|---|---|
| Aurora | `#3CC8A4` | `#0B7259` | salud `healthy` |
| Cielo | `#64B5F6` | `#1D67AD` | `starting`, `recovering`, severidad `info`, foco del teclado |
| Naranja | `#F0904F` | `#A44C14` | `degraded`, severidad `warning` |
| Rojo | `#F27474` | `#B83434` | `failed`, severidades `error` y `critical` |
| Niebla | `#A7B2CB` | `#55627D` | `paused`, modo `disabled` y origen `backtest` |
| Violeta | `#A99AF7` | `#5A47C8` | modo `shadow` (hipotético) |
| Cian | `#4CCAE0` | `#0A6F82` | modo `demo` (dinero de práctica) |
| Rosa | `#F283B3` | `#AA3166` | modo `real` (dinero real) |

Cada tono tiene además un fondo suave para insignias:

| Tono | Tema noche | Tema día |
|---|---|---|
| Aurora | `#0D2925` | `#E1F4EE` |
| Cielo | `#0D2136` | `#E2EDF8` |
| Naranja | `#2E1C10` | `#FAEADC` |
| Rojo | `#2F1518` | `#FAE3E3` |
| Niebla | `#1A2337` (`noche.750`) | `#ECEFF5` (`papel.150`) |
| Violeta | `#1E1A3A` | `#ECE9FB` |
| Cian | `#0B2731` | `#DEF2F5` |
| Rosa | `#2F1526` | `#F9E3ED` |

El modo de ejecución y la salud del servicio son ejes distintos ([fundamentos](../../.kiro/steering/fundamentos-buoh.md)): usan familias de color e iconos distintos y se muestran en lugares distintos. La única excepción es el tono neutro niebla, compartido por `paused` y `disabled`, que se distinguen por su icono, su texto y su lugar. `error` y `critical` comparten tono e icono; `critical` lleva además un borde más marcado. Verde y rojo **no** significan «ganar» y «perder»: un resultado negativo se muestra con su signo y la palabra «pérdida», y el color solo acompaña.

### Temas

- **Noche** es el tema por defecto.
- **Día** existe para leer con luz fuerte y por accesibilidad. Usa los mismos nombres de variable (fondo, texto, borde, acción, tonos) con los valores de la familia papel y los tonos de la columna «Tema día».

## 6. Tipografía

| Familia | Uso | Licencia |
|---|---|---|
| **Manrope** (variable) | títulos, textos e interfaz | SIL OFL 1.1 |
| **JetBrains Mono** (variable) | precios, cifras, identificadores y hashes, con cifras tabulares | SIL OFL 1.1 |

Escala (rem sobre 16 px): 0,75 · 0,8125 · 0,875 · 1 · 1,125 · 1,25 · 1,5 · 1,875 · 2,25 · 3 · 3,75. Títulos en peso 700, texto en 400–500, etiquetas en 600.

## 7. Iconos

- Propios, en SVG, sobre una retícula de 24 px.
- Trazo de 1,75 px, extremos y uniones redondeados, sin rellenos.
- Cada estado tiene un icono fijo. Un mismo icono solo se repite entre ejes cuando el significado es el mismo (por ejemplo, `degraded` y la severidad `warning`); modo y salud nunca comparten icono.
- Las fases del producto (hecha, en curso, prevista) no son estados del servicio: usan el tono neutro niebla y sus propios iconos (bandera, progreso y reloj).

## 8. Gráficos

- Líneas finas sobre fondo noche; sin degradados intensos ni efectos 3D.
- Los huecos y las incidencias de datos se marcan en el gráfico, no se suavizan.
- Toda curva de resultados indica modo, período, muestra y costes en el propio gráfico.

## 9. Movimiento

- Duraciones de 120, 200 y 320 ms, con curva suave.
- Sin parpadeos, pulsos ni sacudidas, tampoco en alertas.
- Con `prefers-reduced-motion`, todo movimiento decorativo se desactiva.

## 10. Accesibilidad

- Contraste WCAG 2.2 AA: 4,5:1 para texto y 3:1 para bordes de controles y texto grande, comprobado por pruebas en ambos temas sobre todos los fondos.
- El texto nunca baja su contraste con opacidad; solo los controles desactivados se atenúan.
- Una insignia nunca desborda su contenedor: si falta espacio, su descripción pasa a otra línea y la etiqueta se mantiene entera.
- Foco del teclado siempre visible, en tono cielo.
- Áreas táctiles de al menos 44 × 44 px en móvil.
- Ninguna información depende solo del color.
