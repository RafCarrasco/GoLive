// Captura o áudio do Windows por processo (process loopback, Windows 10 2004+) e escreve PCM
// 16 bits, 48 kHz, estéreo na saída padrão. Usado pelo app Nimbo para transmitir o som sem
// recapturar as lives que tocam no próprio Nimbo (eco).
//
//   nimbo-audio.exe exclude <pid>   tudo menos o processo e seus filhos (o próprio Nimbo)
//   nimbo-audio.exe window <hwnd>   só o aplicativo dono da janela (e seus filhos)
//
// Termina quando a entrada padrão fecha (o Nimbo saiu) ou em caso de erro (código != 0).
// Compilar: csc /platform:x64 /optimize /out:nimbo-audio.exe NimboAudio.cs
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Nimbo
{
    [StructLayout(LayoutKind.Sequential)]
    struct ActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Blob
    {
        public int cbSize;
        public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public Blob blob;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WaveFormat
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, [In] ref WaveFormat format, [In] ref Guid sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService([In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject
    {
    }

    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            operation.GetActivateResult(out Result, out Client);
            Done.Set();
        }
    }

    static class Program
    {
        const uint StreamFlagsLoopback = 0x00020000;
        const uint StreamFlagsEventCallback = 0x00040000;
        const uint StreamFlagsAutoConvertPcm = 0x80000000;
        const uint StreamFlagsSrcDefaultQuality = 0x08000000;
        const uint BufferFlagsSilent = 0x2;

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation operation);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        static int Fail(string message)
        {
            Console.Error.WriteLine("ERROR " + message);
            return 1;
        }

        [MTAThread]
        static int Main(string[] args)
        {
            if (args.Length != 2) return Fail("uso: exclude <pid> | window <hwnd>");
            uint pid;
            int mode;
            if (args[0] == "exclude")
            {
                mode = 1;
                if (!uint.TryParse(args[1], out pid)) return Fail("pid inválido");
            }
            else if (args[0] == "window")
            {
                mode = 0;
                long hwnd;
                if (!long.TryParse(args[1], out hwnd)) return Fail("janela inválida");
                GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
                if (pid == 0) return Fail("janela não encontrada");
            }
            else return Fail("modo inválido");

            var activation = new ActivationParams { ActivationType = 1, TargetProcessId = pid, ProcessLoopbackMode = mode };
            IntPtr activationPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ActivationParams)));
            IntPtr variantPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PropVariant)));
            Marshal.StructureToPtr(activation, activationPtr, false);
            var variant = new PropVariant { vt = 65 };
            variant.blob.cbSize = Marshal.SizeOf(typeof(ActivationParams));
            variant.blob.pBlobData = activationPtr;
            Marshal.StructureToPtr(variant, variantPtr, false);

            var handler = new CompletionHandler();
            IActivateAudioInterfaceAsyncOperation operation;
            try
            {
                ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, variantPtr, handler, out operation);
            }
            catch (Exception e)
            {
                return Fail("ativação: " + e.Message);
            }
            if (!handler.Done.WaitOne(5000)) return Fail("ativação expirou");
            if (handler.Result != 0 || handler.Client == null) return Fail("ativação 0x" + handler.Result.ToString("X8"));
            var client = (IAudioClient)handler.Client;

            var format = new WaveFormat
            {
                wFormatTag = 1,
                nChannels = 2,
                nSamplesPerSec = 48000,
                wBitsPerSample = 16,
                nBlockAlign = 4,
                nAvgBytesPerSec = 48000 * 4,
                cbSize = 0,
            };
            Guid session = Guid.Empty;
            int hr = client.Initialize(0,
                StreamFlagsLoopback | StreamFlagsEventCallback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality,
                200000, 0, ref format, ref session);
            if (hr != 0) return Fail("Initialize 0x" + hr.ToString("X8"));

            var ready = new AutoResetEvent(false);
            hr = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            if (hr != 0) return Fail("SetEventHandle 0x" + hr.ToString("X8"));
            Guid captureId = typeof(IAudioCaptureClient).GUID;
            object captureObject;
            hr = client.GetService(ref captureId, out captureObject);
            if (hr != 0) return Fail("GetService 0x" + hr.ToString("X8"));
            var capture = (IAudioCaptureClient)captureObject;

            // O Nimbo fecha a entrada padrão ao parar a captura ou ao sair.
            var stop = new ManualResetEvent(false);
            var watcher = new Thread(() =>
            {
                try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { }
                stop.Set();
            });
            watcher.IsBackground = true;
            watcher.Start();

            Stream output = Console.OpenStandardOutput();
            byte[] buffer = new byte[48000 * 4];
            hr = client.Start();
            if (hr != 0) return Fail("Start 0x" + hr.ToString("X8"));
            Console.Error.WriteLine("READY " + pid);

            var waits = new WaitHandle[] { stop, ready };
            try
            {
                while (WaitHandle.WaitAny(waits, 500) != 0)
                {
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpcPosition;
                        hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                        if (hr != 0) return Fail("GetBuffer 0x" + hr.ToString("X8"));
                        int bytes = (int)frames * 4;
                        if (bytes > buffer.Length) buffer = new byte[bytes];
                        if ((flags & BufferFlagsSilent) != 0) Array.Clear(buffer, 0, bytes);
                        else Marshal.Copy(data, buffer, 0, bytes);
                        capture.ReleaseBuffer(frames);
                        output.Write(buffer, 0, bytes);
                    }
                    output.Flush();
                }
            }
            catch (IOException)
            {
                // O Nimbo fechou a saída: encerra normalmente.
            }
            client.Stop();
            return 0;
        }
    }
}
