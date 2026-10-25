//! La ventana solo navega por las páginas empaquetadas con la app. Cualquier otra dirección
//! (internet, archivos del equipo, `javascript:`) se bloquea.

use tauri::{Runtime, Url, plugin::TauriPlugin};

/// Indica si `url` es una página empaquetada. Tauri las sirve desde `http://tauri.localhost`
/// (o `https://` si se activa) en Windows y desde `tauri://localhost` en el resto de sistemas.
pub fn is_bundled_page(url: &Url) -> bool {
    let host = url.host_str();
    let no_credentials = url.username().is_empty() && url.password().is_none();
    let bundled_origin = match url.scheme() {
        "tauri" => host == Some("localhost"),
        "http" | "https" => host == Some("tauri.localhost"),
        _ => false,
    };
    bundled_origin && url.port().is_none() && no_credentials
}

/// Complemento que aplica [`is_bundled_page`] a toda navegación de todas las ventanas.
pub fn only_bundled_pages<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("solo-paginas-empaquetadas")
        .on_navigation(|_webview, url| is_bundled_page(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(address: &str) -> bool {
        is_bundled_page(&Url::parse(address).expect("dirección de prueba válida"))
    }

    #[test]
    fn acepta_las_paginas_empaquetadas() {
        for address in [
            "http://tauri.localhost/",
            "http://tauri.localhost/mercados/",
            "https://tauri.localhost/senales/",
            "tauri://localhost/laboratorio/",
            "http://tauri.localhost/_next/static/chunks/app.js",
        ] {
            assert!(allowed(address), "{address}");
        }
    }

    #[test]
    fn rechaza_cualquier_otra_direccion() {
        for address in [
            "https://deriv.com/",
            "https://example.com/tauri.localhost/",
            "http://tauri.localhost.example.com/",
            "http://evil.tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://usuario@tauri.localhost/",
            "http://localhost:3000/",
            "tauri://example.com/",
            "file:///C:/Windows/System32/",
            "javascript:alert(1)",
            "data:text/html,hola",
            "about:blank",
        ] {
            assert!(!allowed(address), "{address}");
        }
    }
}
