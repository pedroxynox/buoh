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
| | `noche.700` | `#1A273F` | bordes suaves y estados *hover* |
| | `noche.600` | `#25344F` | bordes |
| | `noche.500` | `#5A6C8F` | bordes fuertes de controles |
| Niebla | `niebla.50` | `#F4F6FB` | texto principal |
| | `niebla.200` | `#C8D0E2` | texto secundario |
| | `niebla.300` | `#A7B2CB` | estado en pausa o desactivado |
| | `niebla.400` | `#8D9AB6` | texto tenue |
| Luna | `luna.100` | `#F8F2E1` | acción principal (*hover*) |
| | `luna.200` | `#F0E5C6` | acción principal |
| Ámbar | `ambar.400` | `#F2B544` | ojos del búho y acento de marca |
| | `ambar.700` | `#8A5A00` | acento de marca sobre fondo claro |

Proporción orientativa en una pantalla: 70 % noche, 20 % niebla, 10 % luna y ámbar. El ámbar es el color de la marca: **no** se usa para estados, para que nunca se confunda con una alerta.

### Colores de estado

Un estado nunca se comunica solo con color: siempre lleva texto e icono.

| Tono | Tema noche | Tema día | Se usa para |
|---|---|---|---|
| Aurora | `#3CC8A4` | `#0B7259` | salud `healthy` |
| Cielo | `#64B5F6` | `#1D67AD` | `starting`, `recovering`, severidad `info`, foco del teclado |
| Naranja | `#F0904F` | `#A44C14` | `degraded`, severidad `warning` |
| Rojo | `#F27474` | `#B83434` | `failed`, severidades `error` y `critical` |
| Niebla | `#A7B2CB` | `#55627D` | `paused` y modo `disabled` |
| Violeta | `#A99AF7` | `#5A47C8` | modo `shadow` (hipotético) |
| Cian | `#4CCAE0` | `#0A6F82` | modo `demo` (dinero de práctica) |
| Rosa | `#F283B3` | `#AA3166` | modo `real` (dinero real) |

Cada tono tiene además un fondo suave para insignias (`950` en tema noche, `100` en tema día).

El modo de ejecución y la salud del servicio son ejes distintos ([fundamentos](../../.kiro/steering/fundamentos-buoh.md)): usan familias de color distintas y se muestran en lugares distintos. Verde y rojo **no** significan «ganar» y «perder»: un resultado negativo se muestra con su signo y la palabra «pérdida», y el color solo acompaña.

### Temas

- **Noche** es el tema por defecto.
- **Día** existe para leer con luz fuerte y por accesibilidad. Usa los mismos tokens con otros valores.

## 6. Tipografía

| Familia | Uso | Licencia |
|---|---|---|
| **Manrope** (variable) | títulos, textos e interfaz | SIL OFL 1.1 |
| **JetBrains Mono** (variable) | precios, cifras, identificadores y hashes, con cifras tabulares | SIL OFL 1.1 |

Escala (rem sobre 16 px): 0,75 · 0,8125 · 0,875 · 1 · 1,125 · 1,25 · 1,5 · 1,875 · 2,25 · 3 · 3,75. Títulos en peso 700, texto en 400–500, etiquetas en 600.

## 7. Iconos

- Propios, en SVG, sobre una retícula de 24 px.
- Trazo de 1,75 px, extremos y uniones redondeados, sin rellenos.
- Cada estado tiene un icono fijo (§5) que no se reutiliza para otra cosa.

## 8. Gráficos

- Líneas finas sobre fondo noche; sin degradados intensos ni efectos 3D.
- Los huecos y las incidencias de datos se marcan en el gráfico, no se suavizan.
- Toda curva de resultados indica modo, período, muestra y costes en el propio gráfico.

## 9. Movimiento

- Duraciones de 120, 200 y 320 ms, con curva suave.
- Sin parpadeos, pulsos ni sacudidas, tampoco en alertas.
- Con `prefers-reduced-motion`, todo movimiento decorativo se desactiva.

## 10. Accesibilidad

- Contraste WCAG 2.2 AA: 4,5:1 para texto y 3:1 para bordes de controles y texto grande, comprobado por pruebas en ambos temas.
- Foco del teclado siempre visible, en tono cielo.
- Áreas táctiles de al menos 44 × 44 px en móvil.
- Ninguna información depende solo del color.
