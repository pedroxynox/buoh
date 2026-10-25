# ADR-0011: Identidad visual a partir del logo del propietario

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ámbito:** línea visual V1, incremento V1.6; no cambia el alcance de Fase 1
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Sustituye parcialmente:** [ADR-0008](0008-linea-visual-marca-y-clientes-web.md) §4, en la tipografía (Manrope pasa a Sen). El resto de ADR-0008 sigue vigente.

## Contexto

El propietario aprobó los prototipos y envió un logo propio: un búho de orejas cruzadas en verde azulado y crema, sobre fondo azul noche, junto a la palabra «buoh» ([`docs/diseno/logo-original.jpg`](../../diseno/logo-original.jpg), JPEG de 845 × 348 píxeles). Pidió:

- vectorizarlo y separarlo en piezas para todos los documentos;
- respetar cada trazo, la fuente y los colores;
- llevarlo al diseño con un aspecto más tecnológico y un toque boreal leve;
- que no parezca hecho con IA.

La identidad anterior (búho crema de ojos ámbar, ADR-0008 y guía de marca) no se parece a este logo.

## Decisión

### 1. Vectorización por reconstrucción geométrica

El logo se rehízo con figuras exactas ajustadas al original, no con un trazado automático:

- **Símbolo:** anillo circular, orejas rectas a 45° con la punta curva, párpados en arco que nacen tangentes a las orejas, ojos circulares, pico triangular y una costura de 1 unidad donde cada oreja pasa sobre el anillo.
- **Palabra:** palos rectos y óvalos de tensión ajustable. La «u» no tiene cola, como en el original.

Las medidas se tomaron con detección de bordes a nivel de medio píxel y se ajustaron por mínimos cuadrados sobre la imagen. Las piezas se unen con operaciones booleanas en trazados limpios (24 curvas en el símbolo y 24 en la palabra). Frente al original, el error medio es de 6,7 niveles sobre 255 por canal, casi todo en el suavizado de los bordes del JPEG, y la palabra coincide en un 95 %.

Los trazados viven como datos en `packages/design-system/src/logo.ts`. De ellos salen los SVG de `assets/` y los componentes de la web y el móvil, y una prueba comprueba que coinciden. Las medidas de construcción están en la [guía de marca](../../diseno/marca-buoh.md) §4.

### 2. Colores medidos en el original

- Verde azulado `#24A598`: color de marca (`boreal.400`). No se usa para estados.
- Crema `#EDECE0`: palabra, detalles del símbolo y acción principal (`luna.200`).
- Noche `#080F1B`: fondo general (`noche.900`).

El ámbar deja la paleta. El verde de «saludable» pasa de `#3CC8A4` a `#5CCB7F` para separarse al menos 25° de tono del verde azulado de marca. Todos los pares siguen cumpliendo WCAG 2.2 AA, comprobado por las pruebas del sistema de diseño.

### 3. Tipografía

La palabra del logo no es una fuente instalable, así que siempre se usa su trazado. Para la interfaz se eligió la fuente libre más parecida, midiendo la superposición de «buoh» en 50 familias OFL de Fontsource a pesos 400–700:

| Fuente | Superposición con el original |
|---|---|
| Sen 600 | 90 % |
| Host Grotesk 600 | 89 % |
| Epilogue 600 | 87 % |
| Lexend 500 | 86 % |

Se adopta **Sen** (SIL OFL 1.1). Además de ser la más parecida, dibuja la «u» sin cola, como el logo. Se instala con `@fontsource-variable/sen` 5.3.0 en la web y el sitio, y `@expo-google-fonts/sen` 0.4.2 en el móvil. JetBrains Mono se mantiene para cifras y pasa también a los rótulos técnicos.

### 4. Estilo técnico

- Radios más cortos (4, 6, 10 y 14 px).
- Insignias rectangulares.
- Rótulos y cabeceras de tabla en monoespaciada.
- Una retícula fina en la portada del sitio y un velo boreal tenue detrás del contenido.

Las reglas para no parecer hecho con IA están en la guía §11.

## Consecuencias

- Cambian a la vez el logo, la paleta y la tipografía de la web, el sitio, el móvil y el escritorio. El instalador de escritorio se vuelve a compilar en CI con el icono nuevo.
- La paleta pierde la familia `ambar` y gana `boreal`, y el tema cambia sus variables de marca: `--b-brand-mark` y `--b-brand-mark-detail` sustituyen a `--b-brand-head`, `--b-brand-eye-ring` y `--b-brand-iris`.
- El original queda en el repositorio como referencia para futuras comprobaciones.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Trazado automático (potrace) | Coincide un 95 %, igual que la reconstrucción, pero deja curvas onduladas por el JPEG. |
| Escribir «buoh» con Sen | Sus palos, su altura x y sus curvas difieren del logo; solo coincide en un 90 %. |
| Mantener Manrope | Se parece menos a la palabra del logo. |
| Host Grotesk | Coincide casi igual en conjunto, pero su «u» lleva cola, al contrario que el logo (84 % en esa letra, frente al 89 % de Sen). |
| Degradados boreales intensos | Contradicen la guía (§8) y dan el aspecto genérico que el propietario quiere evitar. |

## Referencias verificadas

- [Fontsource: Sen](https://fontsource.org/fonts/sen)
- [Google Fonts: Sen](https://fonts.google.com/specimen/Sen)
