//! La ventana solo navega por las páginas empaquetadas con la app. Cualquier otra dirección
//! (internet, archivos del equipo, `javascript:`, otro esquema u otro puerto) se bloquea.

use tauri::{Runtime, Url, plugin::TauriPlugin};

/// Esquema y host con que Tauri sirve los archivos empaquetados en Windows (`useHttpsScheme`
/// desactivado).
const WINDOWS_ORIGIN: (&str, &str) = ("http", "tauri.localhost");
/// Esquema y host en macOS y Linux. buoh solo se empaqueta para Windows; se mantiene para que
/// la regla siga siendo correcta si alguien abre la app en otro sistema durante el desarrollo.
const OTHER_ORIGIN: (&str, &str) = ("tauri", "localhost");
/// Origen de las páginas empaquetadas en el sistema donde corre la app.
const BUNDLED_ORIGIN: (&str, &str) = if cfg!(windows) {
    WINDOWS_ORIGIN
} else {
    OTHER_ORIGIN
};

/// Indica si `url` es una página empaquetada en este sistema.
pub fn is_bundled_page(url: &Url) -> bool {
    is_page_of(url, BUNDLED_ORIGIN)
}

fn is_page_of(url: &Url, (scheme, host): (&str, &str)) -> bool {
    url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// Complemento que aplica [`is_bundled_page`] a toda navegación de todas las ventanas. No expone
/// comandos a la página.
pub fn only_bundled_pages<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("solo-paginas-empaquetadas")
        .on_navigation(|_webview, url| is_bundled_page(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed_on_windows(address: &str) -> bool {
        is_page_of(
            &Url::parse(address).expect("dirección de prueba válida"),
            WINDOWS_ORIGIN,
        )
    }

    #[test]
    fn acepta_las_paginas_empaquetadas() {
        for address in [
            "http://tauri.localhost/",
            "http://tauri.localhost/mercados/",
            "HTTP://TAURI.LOCALHOST/senales/",
            "http://tauri.localhost/_next/static/chunks/app.js",
        ] {
            assert!(allowed_on_windows(address), "{address}");
        }
    }

    #[test]
    fn rechaza_cualquier_otra_direccion() {
        for address in [
            "https://deriv.com/",
            "https://tauri.localhost/",
            "tauri://localhost/laboratorio/",
            "https://example.com/tauri.localhost/",
            "http://tauri.localhost.example.com/",
            "http://tauri.localhost./",
            "http://evil.tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://usuario@tauri.localhost/",
            "http://usuario:clave@tauri.localhost/",
            "http://localhost:3000/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "file:///C:/Windows/System32/",
            "javascript:alert(1)",
            "data:text/html,hola",
            "about:blank",
        ] {
            assert!(!allowed_on_windows(address), "{address}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn en_windows_usa_el_origen_http() {
        assert_eq!(BUNDLED_ORIGIN, WINDOWS_ORIGIN);
    }
}
