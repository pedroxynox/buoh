//! Prototipo de escritorio de buoh (ADR-0010): una ventana de Windows que muestra el prototipo web
//! exportado, con datos ficticios. No expone comandos al frontend, no abre conexiones y no guarda
//! nada propio.

// Sin ventana de consola al abrir la app instalada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod navigation;

fn main() {
    tauri::Builder::default()
        .plugin(navigation::only_bundled_pages())
        .run(tauri::generate_context!())
        .expect("no se pudo abrir la ventana de buoh");
}
