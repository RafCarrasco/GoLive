//! Os índices de `list_monitors` têm de ser os do windows-capture: o motor de mídia captura o
//! monitor pelo número que o seletor mostra.

use nimbo_native::list_monitors;
use windows_capture::monitor::Monitor;

#[test]
fn indexes_agree_with_the_media_engine() {
    let ours = list_monitors();
    let theirs = Monitor::enumerate().expect("monitores do windows-capture");
    assert_eq!(ours.len(), theirs.len());
    for (monitor, position) in ours.iter().zip(0..) {
        // O mesmo caminho que o motor usa para abrir a captura.
        let engine = Monitor::from_index(monitor.index).expect("monitor pelo índice");
        assert_eq!(engine, theirs[position]);
        let device = engine.device_name().expect("nome do dispositivo");
        let (width, height) = (engine.width().unwrap(), engine.height().unwrap());
        println!(
            "índice {}: nimbo-native {} {}x{} \"{}\" | windows-capture {} {}x{} \"{}\"",
            monitor.index,
            monitor.device,
            monitor.rect.right - monitor.rect.left,
            monitor.rect.bottom - monitor.rect.top,
            monitor.name,
            device,
            width,
            height,
            engine.name().unwrap_or_default(),
        );
        assert_eq!(monitor.device, device);
        assert_eq!((monitor.rect.right - monitor.rect.left) as u32, width);
        assert_eq!((monitor.rect.bottom - monitor.rect.top) as u32, height);
        assert_eq!(monitor.name, engine.name().unwrap_or_default());
    }
}
