//! Monitores ligados, na mesma ordem e com o mesmo índice que o motor de mídia usa para capturar
//! (`windows_capture::Monitor::from_index`, que é a ordem do `EnumDisplayMonitors`).

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::core::BOOL;

use crate::window::PhysicalPixels;
use crate::{Error, Rect, wide};

/// `MONITORINFO::dwFlags`: este é o monitor principal.
const MONITORINFOF_PRIMARY: u32 = 1;

/// Um monitor ligado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorInfo {
    /// A partir de 1, na ordem do `EnumDisplayMonitors`: é o número que
    /// `windows_capture::Monitor::from_index` espera. Não é o número do `\\.\DISPLAYn`.
    pub index: usize,
    /// Nome do dispositivo no Windows, por exemplo `\\.\DISPLAY1`.
    pub device: String,
    /// Nome do aparelho (o que aparece nas configurações de tela); vazio quando o monitor não
    /// informa, como a tela de muitos notebooks.
    pub name: String,
    /// Posição na área de trabalho, em pixels físicos.
    pub rect: Rect,
    pub primary: bool,
}

/// Os monitores ligados; vazio se o Windows não deixar listar (sessão sem tela).
pub fn list_monitors() -> Vec<MonitorInfo> {
    let _pixels = PhysicalPixels::enter();
    let names = friendly_names();
    handles()
        .into_iter()
        .enumerate()
        .filter_map(|(position, monitor)| {
            let (device, rect, primary) = describe(monitor)?;
            let name = names
                .iter()
                .find(|(gdi, _)| *gdi == device)
                .map(|(_, name)| name.clone())
                .unwrap_or_default();
            Some(MonitorInfo {
                index: position + 1,
                device,
                name,
                rect,
                primary,
            })
        })
        .collect()
}

/// O retângulo (pixels físicos) do monitor com esse índice, para capturar a tela dele.
pub(crate) fn rect_of(index: usize) -> Result<Rect, Error> {
    let _pixels = PhysicalPixels::enter();
    let monitor = index
        .checked_sub(1)
        .and_then(|position| handles().get(position).copied())
        .ok_or(Error::MonitorNotFound)?;
    describe(monitor)
        .map(|(_, rect, _)| rect)
        .ok_or(Error::MonitorNotFound)
}

/// Os monitores na ordem do Windows: a mesma chamada, com os mesmos argumentos, do
/// `Monitor::enumerate` do windows-capture.
fn handles() -> Vec<HMONITOR> {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    // SAFETY: `collect` só usa o ponteiro durante esta chamada, e `monitors` vive até ela voltar.
    // Se falhar, vale o que já foi coletado.
    let _ = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&raw mut monitors as isize),
        )
    };
    monitors
}

unsafe extern "system" fn collect(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    monitors: LPARAM,
) -> BOOL {
    // SAFETY: `monitors` é o endereço do Vec de `handles`, vivo e sem outro acesso enquanto o
    // EnumDisplayMonitors roda (ele chama de volta na mesma thread).
    let monitors = unsafe { &mut *(monitors.0 as *mut Vec<HMONITOR>) };
    monitors.push(monitor);
    true.into()
}

/// Nome do dispositivo, retângulo e se é o principal; `None` se o monitor acabou de sair.
fn describe(monitor: HMONITOR) -> Option<(String, Rect, bool)> {
    let mut info = MONITORINFOEXW {
        monitorInfo: MONITORINFO {
            cbSize: size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: `info` é local e `cbSize` diz que é a estrutura estendida (com o nome), que começa
    // por um MONITORINFO: por isso o ponteiro pode ser passado como o da estrutura menor.
    let found = unsafe { GetMonitorInfoW(monitor, (&raw mut info).cast()) }.as_bool();
    found.then(|| {
        (
            wide(&info.szDevice),
            info.monitorInfo.rcMonitor.into(),
            info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        )
    })
}

/// Pares (nome do dispositivo, nome do aparelho) dos monitores ativos. Vazio se a consulta falhar:
/// o nome do aparelho é só um enfeite.
fn friendly_names() -> Vec<(String, String)> {
    let mut path_count = 0u32;
    let mut mode_count = 0u32;
    // SAFETY: os dois contadores são locais.
    let sized = unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
    };
    if sized != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    // SAFETY: os vetores têm o tamanho que o Windows acabou de pedir, e os contadores levam essa
    // capacidade; na volta trazem quantos itens foram escritos.
    let queried = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    };
    if queried != ERROR_SUCCESS {
        return Vec::new();
    }
    paths.truncate(path_count as usize);
    paths
        .iter()
        .filter_map(|path| {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                    size: size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            // SAFETY: cada cabeçalho está no começo da sua estrutura e informa o tipo e o tamanho
            // dela, que é como o Windows sabe quanto pode escrever.
            let found = unsafe {
                DisplayConfigGetDeviceInfo(&mut source.header) == 0
                    && DisplayConfigGetDeviceInfo(&mut target.header) == 0
            };
            found.then(|| {
                (
                    wide(&source.viewGdiDeviceName),
                    wide(&target.monitorFriendlyDeviceName),
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitors_are_numbered_from_one_with_one_primary() {
        let monitors = list_monitors();
        // Sem tela (sessão de serviço), não há o que conferir.
        if monitors.is_empty() {
            return;
        }
        for (position, monitor) in monitors.iter().enumerate() {
            assert_eq!(monitor.index, position + 1);
            assert!(monitor.device.starts_with(r"\\.\DISPLAY"), "{monitor:?}");
            assert!(monitor.rect.right > monitor.rect.left, "{monitor:?}");
            assert!(monitor.rect.bottom > monitor.rect.top, "{monitor:?}");
            assert_eq!(rect_of(monitor.index), Ok(monitor.rect));
        }
        assert_eq!(monitors.iter().filter(|m| m.primary).count(), 1);
        // O principal é o que tem o canto em (0, 0).
        let primary = monitors.iter().find(|m| m.primary).unwrap();
        assert_eq!((primary.rect.left, primary.rect.top), (0, 0));
    }

    #[test]
    fn index_out_of_range_is_an_error() {
        assert_eq!(rect_of(0), Err(Error::MonitorNotFound));
        assert_eq!(rect_of(999), Err(Error::MonitorNotFound));
    }
}
