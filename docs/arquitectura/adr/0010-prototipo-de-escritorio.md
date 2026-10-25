# ADR-0010: Prototipo de escritorio

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ámbito:** línea visual V1, incremento V1.5; no adelanta la app de Windows de la Fase 7
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Complementa:** [ADR-0001](0001-plataforma-y-stack.md) (decisión 6: Windows con Tauri 2), [ADR-0003](0003-lenguajes-y-limites.md) (Rust solo para el contenedor Tauri) y [ADR-0008](0008-linea-visual-marca-y-clientes-web.md) (que dejaba el escritorio para un incremento propio)

## Contexto

El propietario pidió la app móvil y la de escritorio después del sitio oficial. El móvil llegó en V1.4 ([ADR-0009](0009-prototipo-movil.md)). El [plan de la línea visual](../../plan/linea-visual-v1.md) pedía un incremento propio antes de crear `apps/desktop`. ADR-0001 eligió Tauri 2 para Windows y deja la app real para cuando web y móvil estén validados.

Hechos verificados el 2026-10-25:

- Tauri 2.12.3 es la versión estable (2026-10-10) y pide Rust 1.90 o posterior; su CLI va por la 2.12.4 ([Tauri](https://tauri.app/release/tauri/all-versions/)).
- Rust 1.99.1 es la versión estable (2026-10-13), según el canal oficial de `static.rust-lang.org`.
- El ejecutor `windows-2025` de GitHub Actions trae Rust 1.99.1 y rustup 1.29.1 ([runner-images](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)).
- El entorno de desarrollo no tiene WebView2 ni WebKitGTK, así que la app solo se compila y se prueba entera en CI con Windows.

## Decisión

### 1. Qué es

`apps/desktop` muestra en una ventana de Windows la exportación estática de `apps/web` (`frontendDist: ../../web/out`). Tiene las mismas diez secciones, los mismos datos ficticios y la misma marca «Datos ficticios». La ventana no baja del ancho en que la web cambia a la barra inferior, para conservar la navegación lateral.

No es la app de Windows de la Fase 7, y la decisión 6 de ADR-0001 sigue valiendo para ella. Este prototipo solo comprueba que la interfaz web se puede empaquetar para Windows, y deja al propietario instalarla en su PC.

### 2. Seguridad de la ventana

- El frontend no tiene comandos de Rust, capacidades ni complementos de Tauri. `withGlobalTauri` está desactivado, el protocolo de archivos locales también y `freezePrototype` está activo.
- La política de contenido (CSP) solo permite lo empaquetado, sin `unsafe-eval`. Tauri añade el hash de cada `<script>` en línea que genera Next.js. `style-src-attr 'unsafe-inline'` permite los atributos `style` que escribe React; los elementos `<style>` siguen limitados a lo empaquetado.
- Un complemento propio bloquea toda navegación fuera de las páginas empaquetadas: internet, archivos del equipo, `javascript:` y `data:`.
- Sin actualizaciones automáticas ni conexiones propias.

### 3. Stack

- Tauri 2.12.3 y `tauri-build` 2.7.2, sin la opción `dynamic-acl` (permisos añadidos en ejecución) ni las de Linux. CLI `@tauri-apps/cli` 2.12.4, de la misma serie 2.12.
- Rust 1.99.1, fijado en `rust-toolchain.toml`. `rust-version` es 1.90, la de Tauri. `Cargo.lock` va en el repositorio y todo comando de Cargo usa `--locked`.
- El código Rust se limita a abrir la ventana y a la regla de navegación.
- Instalador NSIS por usuario, que no pide permisos de administrador, en español. Si falta WebView2, descarga su instalador oficial.
- Identificador `io.github.pedroxynox.buoh`, basado en la cuenta de GitHub del propietario, porque buoh todavía no tiene dominio.
- Iconos generados con `tauri icon` desde `packages/design-system/assets/buoh-simbolo.svg`.

### 4. Evidencia

- **En cada `pnpm run verify`:** pruebas de la configuración, de las versiones fijadas y del flujo de CI, y una prueba de que las páginas exportadas no usan nada que la CSP bloquee (manejadores en atributos, `javascript:`, marcos, formularios ni recursos externos).
- **En CI con Windows** (`.github/workflows/desktop.yml`): `cargo fmt`, `cargo clippy` sin avisos, `cargo test` y el instalador, que queda como artefacto 14 días. Corre cuando cambia algo que entra en la app y también se puede lanzar a mano.

El flujo de Windows no corre en cada PR: los minutos de Windows cuestan el doble en un repositorio privado.

### 5. Instalador sin firmar

El instalador no está firmado. Windows SmartScreen avisará al abrirlo. Firmarlo necesita un certificado de pago y queda pendiente.

## Consecuencias

- El propietario puede instalar y abrir el prototipo en su PC antes de la Fase 7.
- Entra Rust en el repositorio, limitado al contenedor como dice ADR-0003, y `Cargo.lock` suma unos 400 paquetes que hay que actualizar cuando haya avisos de seguridad.
- Un cambio en `apps/web` o en `packages/**` también lanza la compilación de Windows.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Electron | ADR-0001 ya eligió Tauri 2, que ocupa menos. |
| Esperar a la Fase 7 | El propietario pidió ver el escritorio ahora; un prototipo con datos ficticios no adelanta funciones. |
| Ventanas que se separan para seguir varios mercados (concepto §7) | Necesitan comandos de Rust o permisos de ventanas; llegan con la app real. |
| Instalador MSI (WiX) | Pide permisos de administrador; NSIS por usuario basta. |
| Caché de compilación de Rust en CI | Añade una acción de terceros; se suma solo si el tiempo de compilación lo justifica. |

## Pendientes

- Probar el instalador en el PC del propietario.
- Firmar el instalador y decidir cómo distribuir la app (sigue en `PROJECT_STATUS.md`).
- En la app real: ventanas separables y un bloqueo explícito de `window.open`.

## Referencias verificadas

- [Tauri: versiones publicadas](https://tauri.app/release/tauri/all-versions/)
- [Tauri: política de contenido (CSP)](https://v2.tauri.app/security/csp/)
- [Tauri: referencia de configuración](https://v2.tauri.app/reference/config/)
- [Tauri: Next.js](https://v2.tauri.app/start/frontend/nextjs/)
- [GitHub Actions: imagen Windows Server 2025](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
