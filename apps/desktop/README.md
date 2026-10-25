# @buoh/desktop — prototipo de escritorio

Prototipo de la app de Windows (`V1-DESKTOP-001`): una ventana de Tauri 2 que muestra el [prototipo web](../web/README.md) exportado, con **datos ficticios**. Decisiones en [ADR-0010](../../docs/arquitectura/adr/0010-prototipo-de-escritorio.md).

No envía órdenes, no se conecta a fuentes ni brókeres, no tiene comandos de Rust para la página y bloquea toda navegación fuera de las páginas empaquetadas.

## Comandos

```text
pnpm --filter @buoh/desktop run test          # configuración, versiones, CI y compatibilidad de la web con la CSP
pnpm --filter @buoh/desktop run typecheck
pnpm --filter @buoh/desktop run tauri:build   # solo en Windows: exporta la web y crea el instalador NSIS
```

El instalador sale en `src-tauri/target/release/bundle/nsis/`. En CI lo compila el flujo [`desktop`](../../.github/workflows/desktop.yml), que también corre `cargo fmt`, `cargo clippy` y `cargo test`, y lo guarda 14 días como artefacto `buoh-escritorio-windows`.

## Instalarlo en Windows

1. Descarga el artefacto `buoh-escritorio-windows` de la última ejecución del flujo `desktop` en GitHub Actions y descomprímelo.
2. Abre `buoh_0.1.0_x64-setup.exe`. No pide permisos de administrador.
3. El instalador no está firmado, así que Windows SmartScreen avisa: «Más información» y «Ejecutar de todas formas».

## Estructura

| Ruta | Qué contiene |
|---|---|
| `src-tauri/tauri.conf.json` | Ventana, política de contenido (CSP), permisos e instalador |
| `src-tauri/src/main.rs` | Abre la ventana |
| `src-tauri/src/navigation.rs` | Regla de navegación y sus pruebas |
| `src-tauri/rust-toolchain.toml`, `Cargo.lock` | Versiones exactas de Rust y de sus paquetes |
| `src-tauri/icons/` | Iconos generados con `tauri icon` desde el símbolo de la marca |
| `test/` | Pruebas que no necesitan Windows |
