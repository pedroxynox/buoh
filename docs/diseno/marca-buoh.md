# Guía de marca de buoh

Fuente canónica de la identidad visual (`V1-BRAND-001`, `V1-BRAND-002`). La identidad parte del logo del propietario ([ADR-0011](../arquitectura/adr/0011-identidad-desde-el-logo-del-propietario.md)). Los valores exactos viven en [`packages/design-system`](../../packages/design-system/README.md); si esta guía y los tokens difieren, se corrige la guía o se versionan los tokens en el mismo PR.

## 1. Idea

buoh viene de **búho**: un ave que observa de noche, con paciencia, y actúa solo cuando ve con claridad. La marca transmite eso:

- **serena:** nada parpadea, nada apura;
- **precisa:** cada número dice de dónde viene y qué tan confiable es;
- **honesta:** muestra pérdidas, límites y dudas igual que los aciertos;
- **nocturna y técnica:** fondo noche, el verde azulado del búho y el crema de su mirada; líneas finas y esquinas precisas, como un instrumento.

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

El logotipo es el del propietario (2026-10-25; original en [`logo-original.jpg`](logo-original.jpg)), vectorizado sin cambiar su dibujo. Los trazados están en [`packages/design-system/src/logo.ts`](../../packages/design-system/src/logo.ts) y los archivos en `packages/design-system/assets/`.

- **Símbolo:** búho de frente dentro de un anillo. Dos orejas rectas a 45° se cruzan en el eje y siguen como párpados bajo cada ojo. El arco superior del anillo, los ojos y el pico van en crema; el resto, en verde azulado.
- **Palabra:** **buoh** en minúsculas, de palos rectos y óvalos casi circulares. La «u» no tiene cola. No es una fuente: siempre se usa el trazado, nunca se escribe con texto.
- **Conjunto:** símbolo a la izquierda y palabra a la derecha, con la separación y la altura del original.

### Construcción

Medidas en unidades del original (845 × 348 px), comprobadas contra la imagen:

| Pieza | Medida |
|---|---|
| Anillo | círculo de radio 79,2 y trazo 15,3 |
| Orejas | rectas a 45°, trazo 15,1; punta afilada por un arco de radio 35,1 a lo largo de 28,8 |
| Cruce | sobre el eje, 6,4 por encima del centro del anillo |
| Párpados | arcos de radio 37,4 y trazo 15,2, que nacen tangentes a las orejas y se funden con el anillo |
| Ojos | círculos de radio 14,4, tapados en parte por las orejas |
| Costura | hueco de 1,0 donde una oreja pasa sobre el anillo |
| Palabra | palos de 19,7; curvas de 17,5 arriba y abajo; altura x 83,8 y ascendentes 121 (0,69) |

### Archivos

| Archivo | Uso |
|---|---|
| `buoh-logo.svg` | conjunto en color sobre fondo oscuro |
| `buoh-logo-dia.svg` | conjunto sobre fondo claro |
| `buoh-logo-mono.svg` | conjunto a una tinta (`currentColor`) |
| `buoh-simbolo.svg`, `-dia`, `-mono` | solo el símbolo, en las mismas tres versiones |
| `buoh-palabra.svg` | solo la palabra, a una tinta |
| `buoh-icono.svg` | icono de app y favicon: símbolo sobre una baldosa noche de esquinas redondeadas |

- **Versión día:** el verde azulado pasa a `boreal.700` y el crema, a `noche.850`.
- **Monocromo:** una sola tinta; los ojos, el pico y el arco superior quedan separados del resto por un hueco de 4 unidades.
- **Área de respeto:** alrededor del logotipo, un espacio libre igual al diámetro de un ojo (28,7 unidades, un 15 % del alto del símbolo).
- **Tamaño mínimo:** símbolo de 16 px de alto; conjunto de 96 px de ancho. El icono de app sigue los tamaños de cada sistema; en el favicon de 16 px el búho se ve como una silueta.

No se permite: redibujar la palabra con una fuente, cambiar los colores fuera de las versiones de arriba, deformar, rotar, añadir contornos, sombras, brillos o degradados, colocarlo sobre fotos sin contraste o animarlo para llamar la atención.

## 5. Paleta

### Colores base

| Familia | Token | Valor | Uso |
|---|---|---|---|
| Noche | `noche.950` | `#050A12` | fondo hundido |
| | `noche.900` | `#080F1B` | fondo general, el del logo |
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
| Luna (crema) | `luna.100` | `#F7F6EF` | acción principal (*hover*) |
| | `luna.200` | `#EDECE0` | palabra y detalles del logo; acción principal |
| Boreal (verde azulado) | `boreal.300` | `#5CC8BA` | líneas de gráficos en tema noche |
| | `boreal.400` | `#24A598` | color de marca: símbolo, navegación activa y selección |
| | `boreal.700` | `#11756B` | color de marca y líneas de gráficos en tema día |
| | `boreal.950` | `#0B2523` | fondo suave de marca (reservado) |

Para el tema día se usa la familia **papel**:

| Token | Valor | Uso en tema día |
|---|---|---|
| `papel.0` | `#FFFFFF` | superficies |
| `papel.50` | `#F5F6FA` | fondo general |
| `papel.100` | `#EEF1F7` | estados *hover* |
| `papel.150` | `#ECEFF5` | fondo hundido e insignias neutras |
| `papel.200` | `#E3E7F0` | bordes suaves |
| `papel.300` | `#CBD2E0` | bordes |
| `papel.500` | `#7D8AA3` | bordes fuertes de controles |
| `papel.600` | `#55627D` | texto tenue y tono niebla (pausa, desactivado, backtest) |
| `papel.700` | `#33415C` | texto secundario |

En tema día, el texto principal, los detalles del logo y la acción principal usan `noche.850` (`#0E1626`), y la acción principal en *hover* usa `noche.700` (`#1A273F`).

Los tres colores del logo se midieron en el original: verde azulado `#24A598`, crema `#EDECE0` y noche `#080F1B`.

Proporción orientativa en una pantalla: 70 % noche, 20 % niebla, 10 % crema y verde azulado. El verde azulado es el color de la marca: **no** se usa para estados, para que nunca se confunda con «saludable».

### Colores de estado

Un estado nunca se comunica solo con color: siempre lleva texto e icono.

| Tono | Tema noche | Tema día | Se usa para |
|---|---|---|---|
| Aurora | `#5CCB7F` | `#16733A` | salud `healthy` |
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
| Aurora | `#0E2A1A` | `#E2F5E8` |
| Cielo | `#0D2136` | `#E2EDF8` |
| Naranja | `#2E1C10` | `#FAEADC` |
| Rojo | `#2F1518` | `#FAE3E3` |
| Niebla | `#1A2337` (`noche.750`) | `#ECEFF5` (`papel.150`) |
| Violeta | `#1E1A3A` | `#ECE9FB` |
| Cian | `#0B2731` | `#DEF2F5` |
| Rosa | `#2F1526` | `#F9E3ED` |

El modo de ejecución y la salud del servicio son ejes distintos ([fundamentos](../../.kiro/steering/fundamentos-buoh.md)): usan familias de color e iconos distintos y se muestran en lugares distintos. La única excepción es el tono neutro niebla, compartido por `paused` y `disabled`, que se distinguen por su icono, su texto y su lugar. `error` y `critical` comparten tono e icono; `critical` lleva además un borde más marcado. El verde de `healthy` se separa al menos 25° de tono del verde azulado de marca. El cian de `demo` queda a unos 15°: de noche es más claro que la marca y de día casi igual de oscuro. Por eso ningún estado se comunica solo con color y el verde azulado nunca aparece en una insignia. Verde y rojo **no** significan «ganar» y «perder»: un resultado negativo se muestra con su signo y la palabra «pérdida», y el color solo acompaña.

### Temas

- **Noche** es el tema por defecto.
- **Día** existe para leer con luz fuerte y por accesibilidad. Usa los mismos nombres de variable (fondo, texto, borde, acción, tonos) con los valores de la familia papel y los tonos de la columna «Tema día».

## 6. Tipografía

| Familia | Uso | Licencia |
|---|---|---|
| **Sen** (variable) | títulos, textos e interfaz | SIL OFL 1.1 |
| **JetBrains Mono** (variable) | precios, cifras, identificadores, hashes y rótulos técnicos, con cifras tabulares | SIL OFL 1.1 |

Sen es la fuente libre más parecida a la palabra del logo: de las 50 familias medidas, es la que más se le superpone (89,6 %, frente al 96 % del trazado vectorizado), y como el logo dibuja la «u» sin cola. La palabra del logo no se escribe con Sen; se usa su trazado.

Escala (rem sobre 16 px): 0,75 · 0,8125 · 0,875 · 1 · 1,125 · 1,25 · 1,5 · 1,875 · 2,25 · 3 · 3,75. Títulos en peso 700, texto en 400–500, etiquetas en 600. Los rótulos sobre los títulos y las cabeceras de tabla van en JetBrains Mono, en mayúsculas y con espaciado de 0,08 em.

## 7. Iconos

- Propios, en SVG, sobre una retícula de 24 px.
- Trazo de 1,75 px, extremos y uniones redondeados, sin rellenos.
- Cada estado tiene un icono fijo. Un mismo icono solo se repite entre ejes cuando el significado es el mismo (por ejemplo, `degraded` y la severidad `warning`); modo y salud nunca comparten icono.
- La campana (`bell`) identifica la pestaña Alertas del móvil; no es un estado.
- Las fases del producto (hecha, en curso, prevista) no son estados del servicio: usan el tono neutro niebla y sus propios iconos (bandera, progreso y reloj).

## 8. Gráficos

- Líneas finas sobre fondo noche; sin degradados intensos ni efectos 3D.
- Los huecos y las incidencias de datos se marcan en el gráfico, no se suavizan.
- Toda curva de resultados lleva su modo, período, muestra y costes en la tarjeta de al lado, que en pantallas estrechas pasa debajo. El gráfico no tiene que repetirlos.

Cómo están hechos hoy los gráficos, y qué parte de estas reglas cumplen, está en [flujo de gráficos](flujo-de-graficas.md). Antes, esta guía pedía ese contexto dentro del gráfico; el propietario decidió el 2026-10-25 que vaya en la tarjeta de al lado (P-V1-03 de la [especificación de pendientes](../plan/especificacion-de-pendientes.md)).

## 9. Movimiento

- Duraciones de 120, 200 y 320 ms, con curva suave.
- Sin parpadeos, pulsos ni sacudidas, tampoco en alertas.
- Con `prefers-reduced-motion`, todo movimiento decorativo se desactiva.

## 10. Accesibilidad

- Contraste WCAG 2.2 AA: 4,5:1 para texto y 3:1 para bordes de controles y texto grande, comprobado por pruebas en ambos temas sobre todos los fondos.
- El texto nunca baja su contraste con opacidad; solo los controles desactivados se atenúan.
- Una insignia nunca desborda su contenedor: si falta espacio, su descripción pasa a otra línea y la etiqueta se mantiene entera.
- Foco del teclado siempre visible, en tono cielo.
- Áreas táctiles de al menos 44 × 44 px en móvil. La app de React Native usa los mismos tokens desde `@buoh/design-system`.
- Ninguna información depende solo del color.

## 11. Estilo técnico y toque boreal

buoh es una herramienta técnica, y la interfaz lo muestra con medios sobrios:

- **Esquinas cortas:** radios de 4, 6, 10 y 14 px. Las insignias son etiquetas rectangulares, no píldoras.
- **Líneas finas:** bordes de 1 px. La portada del sitio lleva una retícula de 56 px casi invisible.
- **Rótulos en monoespaciada:** ver §6.
- **Toque boreal:** un velo de verde azulado de entre el 5 % y el 11 %, en una esquina del fondo o detrás del símbolo, quieto y siempre detrás del contenido. Nunca va sobre texto, botones ni insignias.

Para que no parezca hecho con IA, se evita:

- degradados de neón y combinaciones violeta-rosa de moda;
- brillos, resplandores y sombras de color en botones, tarjetas o en el logo;
- efectos de vidrio en tarjetas o botones;
- ilustraciones 3D, chispas o partículas animadas;
- más de un color de marca en una pantalla.
