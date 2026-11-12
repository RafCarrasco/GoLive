fn main() {
    // Declarar os comandos faz o Tauri exigir uma permissão para cada um: sem isso, comando do
    // app fica liberado para qualquer janela. Quem recebe a permissão está em src/main.rs.
    let commands = tauri_build::AppManifest::new().commands(&["sign_in", "cancel_sign_in"]);
    let attributes = tauri_build::Attributes::new().app_manifest(commands);
    if let Err(e) = tauri_build::try_build(attributes) {
        panic!("falha ao preparar o build do Tauri: {e:#}");
    }
}
