//! Codificador H.264 da placa de vídeo, sem tirar o quadro da GPU.
//!
//! Caminho de cada quadro: textura capturada (BGRA) → processador de vídeo do Direct3D converte e
//! redimensiona para NV12 **na GPU** → codificador por hardware do Windows (Media Foundation: NVIDIA,
//! Intel ou AMD) → H.264 em formato Annex B, pronto para o WebRTC. A CPU só move ponteiros.

use std::mem::ManuallyDrop;
use std::time::Instant;

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize,
    CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate,
    IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFSample, IMFTransform,
    MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, METransformHaveOutput, METransformNeedInput,
    MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_STREAM_CHANGE, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
    MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateSample,
    MFMediaType_Video, MFStartup, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER,
    MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12,
    eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};
use windows::core::Interface;

use crate::AnyError;

/// Quantas texturas NV12 ficam em rodízio. O codificador pode segurar algumas enquanto trabalha.
const POOL: usize = 8;
/// `MF_EVENT_FLAG_NO_WAIT`: pega o evento se houver, sem esperar.
const NO_WAIT: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS = MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(1);
const MF_VIDEO_INTERLACE_PROGRESSIVE: u32 = 2;

pub struct HwEncoder {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: Option<ICodecAPI>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    /// Cópia do quadro capturado numa textura nossa, que o processador de vídeo aceita como entrada.
    source: ID3D11Texture2D,
    source_view: ID3D11VideoProcessorInputView,
    pool: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    next: usize,
    /// Quantos quadros o codificador pediu e ainda não recebeu.
    wants: u32,
    fps: u32,
    start: Instant,
    pub name: String,
    pub width: u32,
    pub height: u32,
    _manager: IMFDXGIDeviceManager,
}

// SAFETY: os objetos COM daqui vêm de um dispositivo Direct3D com proteção multithread ligada e de
// um MFT assíncrono; o codificador inteiro é usado por uma thread de cada vez (a da captura).
unsafe impl Send for HwEncoder {}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn variant_u32(value: u32) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: VARIANT recém-zerada; escrevemos o tipo e o campo que corresponde a ele.
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = value;
    }
    v
}

fn variant_bool(value: bool) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: idem; VARIANT_BOOL verdadeiro é -1.
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal =
            windows::Win32::Foundation::VARIANT_BOOL(if value { -1 } else { 0 });
    }
    v
}

impl HwEncoder {
    /// `input` é o tamanho da textura capturada; `output`, o do vídeo enviado (lados pares).
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        input: (u32, u32),
        output: (u32, u32),
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, AnyError> {
        let (width, height) = (output.0 & !1, output.1 & !1);
        // SAFETY: chamadas COM/Media Foundation com ponteiros para variáveis locais vivas durante a
        // chamada; cada interface retornada é contada por referência pelo próprio tipo.
        unsafe {
            MFStartup(MF_VERSION, 0)?;
            // O codificador usa o dispositivo em threads dele: o Direct3D precisa se proteger.
            let _ = context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);

            // ---- conversão BGRA → NV12 na GPU ----
            let video_device: ID3D11VideoDevice = device.cast()?;
            let video_context: ID3D11VideoContext = context.cast()?;
            let rate = DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(
                &D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: rate,
                    InputWidth: input.0,
                    InputHeight: input.1,
                    OutputFrameRate: rate,
                    OutputWidth: width,
                    OutputHeight: height,
                    Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
                },
            )?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let full = RECT {
                left: 0,
                top: 0,
                right: input.0 as i32,
                bottom: input.1 as i32,
            };
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&full));
            let target = RECT {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&target));

            let texture =
                |w: u32, h: u32, format, bind: u32| -> Result<ID3D11Texture2D, AnyError> {
                    let desc = D3D11_TEXTURE2D_DESC {
                        Width: w,
                        Height: h,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: format,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: bind,
                        CPUAccessFlags: 0,
                        MiscFlags: 0,
                    };
                    let mut out = None;
                    device.CreateTexture2D(&desc, None, Some(&mut out))?;
                    out.ok_or_else(|| "CreateTexture2D não devolveu textura".into())
                };
            let bind = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
            let source = texture(input.0, input.1, DXGI_FORMAT_B8G8R8A8_UNORM, bind)?;
            let mut source_view = None;
            video_device.CreateVideoProcessorInputView(
                &source,
                &enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
                },
                Some(&mut source_view),
            )?;
            let source_view = source_view.ok_or("sem vista de entrada do processador de vídeo")?;
            let mut pool = Vec::with_capacity(POOL);
            for _ in 0..POOL {
                let nv12 = texture(
                    width,
                    height,
                    DXGI_FORMAT_NV12,
                    D3D11_BIND_RENDER_TARGET.0 as u32,
                )?;
                let mut view = None;
                video_device.CreateVideoProcessorOutputView(
                    &nv12,
                    &enumerator,
                    &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                        },
                    },
                    Some(&mut view),
                )?;
                pool.push((
                    nv12,
                    view.ok_or("sem vista de saída do processador de vídeo")?,
                ));
            }

            // ---- codificador por hardware ----
            let wanted_in = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_NV12,
            };
            let wanted_out = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut count = 0u32;
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&wanted_in),
                Some(&wanted_out),
                &mut list,
                &mut count,
            )?;
            let activates: Vec<IMFActivate> = (0..count as usize)
                .filter_map(|i| (*list.add(i)).take())
                .collect();
            CoTaskMemFree(Some(list.cast()));
            let activate = activates
                .first()
                .ok_or("esta máquina não tem codificador H.264 na placa de vídeo")?;
            let name = friendly_name(activate);
            let transform: IMFTransform = activate.ActivateObject()?;
            transform
                .GetAttributes()?
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;

            let mut token = 0u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.ok_or("sem gerenciador de dispositivo DXGI")?;
            manager.ResetDevice(device, token)?;
            transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;

            // Baixa latência e taxa constante: ajustes opcionais, cada driver aceita um conjunto.
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(codec) = &codec {
                let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &variant_bool(true));
                let _ = codec.SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32),
                );
                let _ = codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variant_u32(bitrate));
                let _ = codec.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &variant_u32(0));
                // Quadro completo só quando alguém pede (entrou espectador ou perdeu pacote).
                let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &variant_u32(fps * 60));
            }

            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            out_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MF_VIDEO_INTERLACE_PROGRESSIVE)?;
            out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            transform.SetOutputType(0, &out_type, 0)?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            in_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MF_VIDEO_INTERLACE_PROGRESSIVE)?;
            transform.SetInputType(0, &in_type, 0)?;

            let events: IMFMediaEventGenerator = transform.cast()?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            Ok(Self {
                transform,
                events,
                codec,
                device: device.clone(),
                context: context.clone(),
                video_device,
                video_context,
                processor,
                enumerator,
                source,
                source_view,
                pool,
                next: 0,
                wants: 0,
                fps,
                start: Instant::now(),
                name,
                width,
                height,
                _manager: manager,
            })
        }
    }

    /// Muda a taxa de bits com a live no ar (controle de banda).
    pub fn set_bitrate(&mut self, bitrate: u32) {
        if let Some(codec) = &self.codec {
            // SAFETY: VARIANT local válida durante a chamada.
            let _ =
                unsafe { codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variant_u32(bitrate)) };
        }
    }

    /// Entrega um quadro capturado. Devolve em `out` os quadros H.264 que ficaram prontos (em geral
    /// o anterior). Retorna `false` se o codificador estava ocupado e o quadro foi descartado.
    pub fn encode(
        &mut self,
        frame: &ID3D11Texture2D,
        keyframe: bool,
        out: &mut Vec<Vec<u8>>,
    ) -> Result<bool, AnyError> {
        self.drain(out)?;
        if self.wants == 0 {
            return Ok(false);
        }
        // SAFETY: texturas e vistas pertencem ao mesmo dispositivo; os ponteiros passados apontam para
        // valores locais vivos durante cada chamada.
        unsafe {
            self.context.CopyResource(&self.source, frame);
            let (nv12, view) = &self.pool[self.next];
            self.next = (self.next + 1) % POOL;
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(self.source_view.clone())),
                ..Default::default()
            };
            let blt = self.video_context.VideoProcessorBlt(
                &self.processor,
                view,
                0,
                std::slice::from_ref(&stream),
            );
            drop(ManuallyDrop::into_inner(stream.pInputSurface));
            blt?;

            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)?;
            let sample: IMFSample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime((self.start.elapsed().as_nanos() / 100) as i64)?;
            sample.SetSampleDuration(10_000_000 / i64::from(self.fps))?;
            if keyframe && let Some(codec) = &self.codec {
                let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variant_u32(1));
            }
            self.transform.ProcessInput(0, &sample, 0)?;
        }
        self.wants -= 1;
        self.drain(out)?;
        Ok(true)
    }

    /// Lê os avisos do codificador: "quero um quadro" e "tenho um quadro pronto".
    fn drain(&mut self, out: &mut Vec<Vec<u8>>) -> Result<(), AnyError> {
        loop {
            // SAFETY: chamada COM simples; o evento retornado é contado por referência.
            let event = match unsafe { self.events.GetEvent(NO_WAIT) } {
                Ok(event) => event,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            // SAFETY: idem.
            let kind = unsafe { event.GetType()? };
            if kind == METransformNeedInput.0 as u32 {
                self.wants += 1;
            } else if kind == METransformHaveOutput.0 as u32
                && let Some(data) = self.output()?
            {
                out.push(data);
            }
        }
    }

    fn output(&mut self) -> Result<Option<Vec<u8>>, AnyError> {
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER::default()];
        let mut status = 0u32;
        // SAFETY: `buffers` e `status` vivem durante a chamada; o codificador por hardware aloca a
        // amostra de saída, que assumimos (take) logo abaixo para não vazar.
        let result = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
        // SAFETY: os campos são ManuallyDrop escritos pela chamada acima; tomamos posse uma única vez.
        let sample = unsafe { ManuallyDrop::take(&mut buffers[0].pSample) };
        unsafe { ManuallyDrop::drop(&mut buffers[0].pEvents) };
        match result {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // O codificador redefiniu a saída: aceita o tipo que ele propõe e segue.
                // SAFETY: chamadas COM simples.
                unsafe {
                    let proposed = self.transform.GetOutputAvailableType(0, 0)?;
                    self.transform.SetOutputType(0, &proposed, 0)?;
                }
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        }
        let Some(sample) = sample else {
            return Ok(None);
        };
        // SAFETY: Lock devolve um ponteiro válido por `len` bytes até o Unlock; copiamos antes dele.
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len))?;
            let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            buffer.Unlock()?;
            Ok(Some(data))
        }
    }

    /// Mantém vivos os objetos que as vistas e o processador referenciam.
    #[allow(dead_code)]
    fn keep_alive(
        &self,
    ) -> (
        &ID3D11Device,
        &ID3D11VideoDevice,
        &ID3D11VideoProcessorEnumerator,
    ) {
        (&self.device, &self.video_device, &self.enumerator)
    }
}

fn friendly_name(activate: &IMFActivate) -> String {
    use windows::Win32::Media::MediaFoundation::MFT_FRIENDLY_NAME_Attribute;
    let mut buffer = [0u16; 256];
    let mut len = 0u32;
    // SAFETY: buffer local com o tamanho informado; `len` recebe quantos caracteres foram escritos.
    let ok =
        unsafe { activate.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buffer, Some(&mut len)) };
    if ok.is_ok() {
        String::from_utf16_lossy(&buffer[..len as usize])
    } else {
        "codificador por hardware".into()
    }
}
