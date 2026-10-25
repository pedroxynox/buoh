# ADR-0009: Prototipo móvil

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ámbito:** línea visual V1, incremento V1.4; no cambia el alcance de Fase 1 ni adelanta la Fase 3
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Complementa:** [ADR-0001](0001-plataforma-y-stack.md) (móvil con Expo y React Native) y [ADR-0008](0008-linea-visual-marca-y-clientes-web.md) (que dejaba el móvil para un incremento propio)

## Contexto

El propietario pidió seguir con la aplicación móvil y la de escritorio después del sitio oficial. ADR-0008 autorizó el prototipo web y el sitio, y dejó el móvil y el escritorio para incrementos propios del [plan de la línea visual](../../plan/linea-visual-v1.md). ADR-0001 ya eligió Expo y React Native para Android e iOS.

Hechos verificados el 2026-10-25:

- Expo SDK 58 es la versión estable; usa React Native 0.88 y React 19.3.0 ([Expo](https://expo.dev/changelog/sdk-58), [React Native](https://reactnative.dev/blog/2026/10/19/react-native-0.88)).
- La lista de módulos compatibles del SDK (`expo/bundledNativeModules.json`) fija `react` y `react-dom` en 19.3.0, y React exige que su versión coincida exactamente con la del renderizador de React Native.
- Desde el SDK 54, Expo admite las instalaciones aisladas de pnpm, que usa este repositorio ([Expo](https://docs.expo.dev/guides/monorepos/)).
- Expo Go para el SDK 58 todavía no está en App Store ni Google Play; Expo anuncia que llegará en unas semanas ([Expo](https://expo.dev/changelog/sdk-58)).

## Decisión

### 1. Qué es

`apps/mobile` es un prototipo navegable de la app de Android e iOS con datos ficticios. Tiene cinco pestañas, como pide el [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §7:

- Inicio;
- Señales;
- Alertas;
- Evidencia;
- Más, que incluye las fuentes, lo que llega en fases posteriores (con candado) y lo que solo se hace en la web o el escritorio.

Sigue las reglas de ADR-0008 §2. Como dice el [catálogo de funciones](../../producto/funciones-y-disponibilidad.md), no edita estrategias ni políticas. Pedir el modo real llega al móvil en la Fase 6 (el propietario lo decidió el 2026-10-25, después de aceptarse esta ADR), así que el prototipo lo muestra con candado y sin controles.

Además, como es un prototipo, sus únicos controles cambian de pestaña: «Ver alertas» en Inicio y «Ver evidencia» en cada señal. El *kill switch* con candado va lo primero en «Más».

### 2. Datos compartidos

Los datos ficticios pasan de `apps/web` a `packages/prototype-data`, con sus pruebas de coherencia. Así la web, el móvil y el futuro escritorio cuentan la misma historia. También viven allí los valores que ambas apps muestran igual: el resultado en shadow (`SHADOW_RESULT`), el estado de cada señal (`SIGNAL_STATUS`) y el contexto de cada validación (`validationContextOf`). Los tipos de una cifra de desempeño (`PerformanceContext`) pasan al núcleo de `packages/design-system`, que no depende de React.

Los formatos de fecha (`formatUtc`, `formatUtcTime`) y el cálculo de la peor caída (`worstDrawdown`) también se mudan, aunque no son datos ficticios. Es la opción más simple mientras solo los usan los prototipos. Cuando la Fase 2 traiga datos reales, se moverán a un paquete propio para que el código de producción no dependa de los datos del prototipo.

### 3. Stack

- Expo SDK 58: `expo` 58.0.19, React Native 0.88.0 y React 19.3.0, las versiones de su lista de compatibles.
- `expo-font` 58.0.10 carga las tipografías, `expo-status-bar` 58.0.4 controla la barra de estado y `@expo/metro-runtime` 58.0.15 hace funcionar la versión web.
- La web y el sitio siguen en React 19.3.1, la versión con la que se fijaron Next.js y el sitio (ADR-0008). Cada app instala su propia copia, así que el móvil puede quedarse en 19.3.0. Por eso el sistema de diseño acepta React `^19.3.0`.
- `react-native-svg` para iconos, logotipo y gráficos, y `react-native-safe-area-context` para respetar los bordes del teléfono.
- `react-native-web` para generar una versión web del prototipo y para las pruebas.
- Tipografías Manrope y JetBrains Mono de `@expo-google-fonts` (OFL), empaquetadas en la app.
- Sin biblioteca de navegación: una barra inferior propia basta para cinco pestañas y evita dependencias que el prototipo no necesita.
- Metro resuelve los paquetes del monorepo desde su build (`experiments.tsconfigPaths: false`), igual que Next.js.
- La telemetría de Expo se desactiva en los scripts.

### 4. Evidencia sin teléfono

El sandbox y CI no tienen emuladores ni cuentas de tienda. La evidencia es:

- `expo export` compila los paquetes JavaScript de Android, iOS y web en cada `build`;
- las pruebas renderizan cada pestaña con React Native for Web y comprueban su contenido;
- capturas de la versión web en tamaño de teléfono.

Probar en un teléfono real (Expo Go cuando salga para el SDK 58, o una compilación nativa) y publicar en las tiendas quedan pendientes. No forman parte de este incremento.

## Consecuencias

- El propietario puede revisar la app móvil antes de la Fase 3, con la misma marca y los mismos datos que la web.
- Conviven dos versiones de React en el monorepo, una por app. Dos controles evitan que se mezclen en el móvil: ESLint prohíbe importar `@buoh/design-system/react` (que trae 19.3.1) desde `apps/mobile`, y una prueba comprueba que los paquetes de `out/` solo contienen React 19.3.0.
- `pnpm run build` tarda más, porque compila la app para tres plataformas.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Expo Router o React Navigation | Más dependencias para cinco pestañas sin enlaces profundos. |
| `jest-expo` para las pruebas | Añade un segundo ejecutor de pruebas; Vitest con React Native for Web comprueba el mismo contenido. |
| Componentes React Native dentro de `packages/design-system` | Haría depender el paquete de React Native; se decide cuando la app real lo necesite. |
| Copiar los datos ficticios en el móvil | Dos historias que se desincronizarían. |

## Pendientes

- Probar en un teléfono real y elegir cómo distribuir la app (sigue en `PROJECT_STATUS.md`).
- Prototipo de escritorio (V1.5), con su propio incremento.

## Referencias verificadas

- [Expo SDK 58](https://expo.dev/changelog/sdk-58)
- [React Native 0.88](https://reactnative.dev/blog/2026/10/19/react-native-0.88)
- [Expo y monorepos](https://docs.expo.dev/guides/monorepos/)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
