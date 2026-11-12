//! Imagem em memória: reduzir um quadro capturado e gravar em JPEG ou PNG. A gravação usa o
//! codificador que já vem no Windows (Windows Imaging Component), para não trazer mais uma
//! biblioteca só por causa de miniaturas.

use std::ffi::c_void;

use windows::Win32::Graphics::Gdi::{HBITMAP, HPALETTE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_ContainerFormatPng,
    GUID_WICPixelFormat24bppBGR, GUID_WICPixelFormat32bppBGR, GUID_WICPixelFormat32bppBGRA,
    GUID_WICPixelFormat32bppPBGRA, IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapEncoderNoCache, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
    WICBitmapUsePremultipliedAlpha,
};
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use windows::Win32::System::Variant::{VARIANT, VT_R4};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::HICON;
use windows::core::{GUID, PWSTR, w};

use crate::Error;

/// Formato do arquivo de uma imagem devolvida pela biblioteca.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    /// Sem transparência e pequeno: o padrão das miniaturas.
    Jpeg,
    /// Sem perda e com transparência: o formato dos ícones.
    Png,
}

/// O maior ícone que o Windows guarda (256 x 256); pedir mais só ampliaria.
pub(crate) const MAX_ICON: u32 = 256;

/// Qualidade do JPEG das miniaturas (0 a 1). Com 0,8 o texto de uma janela reduzida continua
/// legível e o arquivo fica várias vezes menor que o PNG.
const JPEG_QUALITY: f32 = 0.8;

/// Imagem pequena já reduzida: BGRA, de cima para baixo, sem folga entre as linhas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl Bitmap {
    /// Tudo preto: o que sobra quando o Windows não entrega a imagem de uma janela.
    pub fn is_black(&self) -> bool {
        let (pixels, _) = self.bgra.as_chunks::<4>();
        pixels.iter().all(|pixel| pixel[..3] == [0, 0, 0])
    }
}

/// O pedaço de um quadro capturado que vira a miniatura (uma janela sem as bordas invisíveis).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Area {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

/// O maior tamanho que cabe em `max_width` x `max_height` mantendo a proporção, sem ampliar.
pub(crate) fn fit(width: usize, height: usize, max_width: u32, max_height: u32) -> (usize, usize) {
    let (max_width, max_height) = (max_width.max(1) as usize, max_height.max(1) as usize);
    if width <= max_width && height <= max_height {
        return (width, height);
    }
    // Quem estoura mais (largura ou altura) manda; a outra medida acompanha, arredondada.
    if width * max_height >= height * max_width {
        let scaled = (height * max_width + width / 2) / width;
        (max_width, scaled.clamp(1, max_height))
    } else {
        let scaled = (width * max_height + height / 2) / height;
        (scaled.clamp(1, max_width), max_height)
    }
}

/// Reduz `area` de um quadro BGRA (`stride` bytes por linha) para caber no tamanho pedido. Cada
/// pixel da miniatura é a média do bloco que ele cobre: texto pequeno vira um borrão legível, em
/// vez de sumir como sumiria pegando um pixel a cada tantos.
pub(crate) fn shrink(
    pixels: &[u8],
    stride: usize,
    area: Area,
    max_width: u32,
    max_height: u32,
) -> Bitmap {
    let (width, height) = fit(area.width, area.height, max_width, max_height);
    // Onde começa, no quadro, o bloco de cada coluna da miniatura (e onde acaba a última).
    let columns: Vec<usize> = (0..=width)
        .map(|x| area.x + x * area.width / width)
        .collect();
    let mut bgra = Vec::with_capacity(width * height * 4);
    let mut sums = vec![[0u64; 3]; width];
    for y in 0..height {
        let top = area.y + y * area.height / height;
        let bottom = area.y + (y + 1) * area.height / height;
        sums.fill([0; 3]);
        for row in top..bottom {
            let line = &pixels[row * stride..];
            for (sum, block) in sums.iter_mut().zip(columns.windows(2)) {
                for pixel in line[block[0] * 4..block[1] * 4].as_chunks::<4>().0 {
                    sum[0] += u64::from(pixel[0]);
                    sum[1] += u64::from(pixel[1]);
                    sum[2] += u64::from(pixel[2]);
                }
            }
        }
        for (sum, block) in sums.iter().zip(columns.windows(2)) {
            let count = ((bottom - top) * (block[1] - block[0])) as u64;
            bgra.extend(sum.map(|channel| (channel / count) as u8));
            bgra.push(255);
        }
    }
    Bitmap {
        width: width as u32,
        height: height as u32,
        bgra,
    }
}

/// Grava a imagem reduzida no formato pedido. A transparência é ignorada: captura de tela não tem.
pub(crate) fn encode(bitmap: &Bitmap, format: ImageFormat) -> Result<Vec<u8>, Error> {
    let _com = Com::enter();
    let factory = factory()?;
    // SAFETY: o buffer tem `width * height * 4` bytes (montado por `shrink`), que é o que o
    // formato de 32 bits e o passo de `width * 4` descrevem; o WIC copia os pixels nesta chamada.
    let source = unsafe {
        factory.CreateBitmapFromMemory(
            bitmap.width,
            bitmap.height,
            &GUID_WICPixelFormat32bppBGR,
            bitmap.width * 4,
            &bitmap.bgra,
        )
    }?;
    let container = match format {
        ImageFormat::Jpeg => GUID_ContainerFormatJpeg,
        ImageFormat::Png => GUID_ContainerFormatPng,
    };
    write(
        &factory,
        &source.into(),
        bitmap.width,
        bitmap.height,
        container,
        GUID_WICPixelFormat24bppBGR,
    )
}

/// Um ícone como o Windows entrega.
pub(crate) enum IconImage {
    /// Ícone de janela ou de classe.
    Icon(HICON),
    /// Imagem de 32 bits do shell, com a cor já multiplicada pela transparência.
    ShellBitmap(HBITMAP),
}

/// O ícone em PNG de `size` x `size`, com a transparência dele.
pub(crate) fn icon_png(icon: IconImage, size: u32) -> Result<Vec<u8>, Error> {
    let size = size.clamp(1, MAX_ICON);
    let _com = Com::enter();
    let factory = factory()?;
    // SAFETY: o ícone ou bitmap é válido (quem chama garante); o WIC copia os pixels dele nesta
    // chamada, sem ficar com o identificador. As demais chamadas só ligam objetos do próprio WIC.
    let scaled: IWICBitmapSource = unsafe {
        let bitmap = match icon {
            IconImage::Icon(icon) => factory.CreateBitmapFromHICON(icon)?,
            IconImage::ShellBitmap(bitmap) => factory.CreateBitmapFromHBITMAP(
                bitmap,
                HPALETTE::default(),
                WICBitmapUsePremultipliedAlpha,
            )?,
        };
        // Cor já multiplicada pela transparência antes de redimensionar: sem isso a borda do
        // ícone ganha um contorno escuro (a cor "escondida" dos pixels transparentes vaza).
        let premultiplied = factory.CreateFormatConverter()?;
        premultiplied.Initialize(
            &bitmap,
            &GUID_WICPixelFormat32bppPBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&premultiplied, size, size, WICBitmapInterpolationModeFant)?;
        let straight = factory.CreateFormatConverter()?;
        straight.Initialize(
            &scaler,
            &GUID_WICPixelFormat32bppBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        straight.into()
    };
    write(
        &factory,
        &scaled,
        size,
        size,
        GUID_ContainerFormatPng,
        GUID_WICPixelFormat32bppBGRA,
    )
}

fn factory() -> Result<IWICImagingFactory, Error> {
    // SAFETY: cria um objeto COM do sistema; quem chama já entrou no COM (`Com::enter`).
    Ok(unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }?)
}

/// Codifica uma fonte do WIC num arquivo em memória e devolve os bytes.
fn write(
    factory: &IWICImagingFactory,
    source: &IWICBitmapSource,
    width: u32,
    height: u32,
    container: GUID,
    pixels: GUID,
) -> Result<Vec<u8>, Error> {
    // SAFETY: sequência documentada do codificador do WIC, toda com objetos e variáveis locais
    // que vivem até o fim do bloco. Os ponteiros de saída apontam para `Option`s locais, e a
    // leitura final copia no máximo `data.len()` bytes para `data`.
    unsafe {
        let stream = SHCreateMemStream(None).ok_or(Error::Os(E_OUTOFMEMORY))?;
        let encoder = factory.CreateEncoder(&container, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut options: Option<IPropertyBag2> = None;
        encoder.CreateNewFrame(&mut frame, &mut options)?;
        let frame = frame.ok_or(Error::Os(E_POINTER))?;
        if let (true, Some(options)) = (container == GUID_ContainerFormatJpeg, &options) {
            let name = PROPBAG2 {
                pstrName: PWSTR(w!("ImageQuality").as_ptr().cast_mut()),
                ..Default::default()
            };
            let mut quality = VARIANT::default();
            let value = &mut *quality.Anonymous.Anonymous;
            value.vt = VT_R4;
            value.Anonymous.fltVal = JPEG_QUALITY;
            // Se o codificador recusar a opção, fica a qualidade padrão dele.
            let _ = options.Write(1, &name, &quality);
        }
        frame.Initialize(options.as_ref())?;
        frame.SetSize(width, height)?;
        let mut accepted = pixels;
        frame.SetPixelFormat(&mut accepted)?;
        // O codificador converte a fonte para o formato que aceitou.
        frame.WriteSource(source, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;

        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut data = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream
            .Read(
                data.as_mut_ptr().cast::<c_void>(),
                data.len() as u32,
                Some(&mut read),
            )
            .ok()?;
        data.truncate(read as usize);
        Ok(data)
    }
}

/// `E_OUTOFMEMORY` e `E_POINTER`, para as duas falhas que não trazem código do Windows.
const E_OUTOFMEMORY: i32 = 0x8007_000E_u32 as i32;
const E_POINTER: i32 = 0x8000_4003_u32 as i32;

/// Enquanto existir, esta thread está no COM (o WIC e o shell precisam). Se a thread já estava em
/// outro modo (a da interface gráfica), o COM já está ligado e não há o que desfazer.
pub(crate) struct Com(bool);

impl Com {
    pub(crate) fn enter() -> Self {
        // SAFETY: liga o COM nesta thread; cada sucesso é desfeito em `drop`.
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: desfaz exatamente a ligação bem-sucedida de `enter`, na mesma thread.
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHOLE: fn(usize, usize) -> Area = |width, height| Area {
        x: 0,
        y: 0,
        width,
        height,
    };

    #[test]
    fn fits_inside_the_box_keeping_the_proportion() {
        assert_eq!(fit(1920, 1080, 400, 250), (400, 225));
        assert_eq!(fit(1080, 1920, 400, 250), (141, 250));
        assert_eq!(fit(2560, 1440, 400, 250), (400, 225));
        // Não amplia o que já cabe.
        assert_eq!(fit(300, 200, 400, 250), (300, 200));
        // Janela muito comprida não some: sobra pelo menos um pixel.
        assert_eq!(fit(4000, 2, 400, 250), (400, 1));
        assert_eq!(fit(2, 4000, 400, 250), (1, 250));
        assert_eq!(fit(1920, 1080, 0, 0), (1, 1));
    }

    #[test]
    fn shrinking_averages_each_block() {
        // 4x2: metade esquerda branca, metade direita preta; vira 2x1 com as duas cores puras.
        let white = [255, 255, 255, 0];
        let black = [0, 0, 0, 0];
        let row = [white, white, black, black].concat();
        let pixels = [row.clone(), row].concat();
        let small = shrink(&pixels, 16, WHOLE(4, 2), 2, 1);
        assert_eq!((small.width, small.height), (2, 1));
        assert_eq!(small.bgra, [255, 255, 255, 255, 0, 0, 0, 255]);
        // Reduzindo tudo a um pixel, a média é cinza.
        let one = shrink(&pixels, 16, WHOLE(4, 2), 1, 1);
        assert_eq!(one.bgra, [127, 127, 127, 255]);
        assert!(!small.is_black());
    }

    #[test]
    fn shrinking_respects_the_area_and_the_stride() {
        // 3x2 com 4 bytes de folga por linha; só a coluna do meio (azul puro) interessa.
        let blue = [255, 0, 0, 0];
        let red = [0, 0, 255, 0];
        let padding = [9, 9, 9, 9];
        let row = [red, blue, red, padding].concat();
        let pixels = [row.clone(), row].concat();
        let area = Area {
            x: 1,
            y: 0,
            width: 1,
            height: 2,
        };
        let small = shrink(&pixels, 16, area, 400, 250);
        assert_eq!((small.width, small.height), (1, 2));
        assert_eq!(small.bgra, [255, 0, 0, 255, 255, 0, 0, 255]);
    }

    #[test]
    fn black_frames_are_recognised() {
        let black = shrink(&[0u8; 64], 16, WHOLE(4, 4), 2, 2);
        assert!(black.is_black());
    }

    #[test]
    fn encodes_real_jpeg_and_png_files() {
        // Degradê 64x48, para o arquivo ter o que comprimir.
        let mut pixels = Vec::new();
        for y in 0..48u32 {
            for x in 0..64u32 {
                pixels.extend([(x * 4) as u8, (y * 5) as u8, 128, 0]);
            }
        }
        let bitmap = shrink(&pixels, 64 * 4, WHOLE(64, 48), 64, 48);
        let jpeg = encode(&bitmap, ImageFormat::Jpeg).unwrap();
        assert_eq!(jpeg[..3], [0xFF, 0xD8, 0xFF]);
        let png = encode(&bitmap, ImageFormat::Png).unwrap();
        assert_eq!(png[..8], *b"\x89PNG\r\n\x1a\n");
        // Largura e altura no cabeçalho do PNG (IHDR), em big-endian.
        assert_eq!(png[16..24], [0, 0, 0, 64, 0, 0, 0, 48]);
    }
}
