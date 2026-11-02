// Captura o áudio do Windows por processo (process loopback, Windows 10 2004+) e escreve PCM
// 16 bits, 48 kHz, estéreo na saída padrão. Usado pelo app Nimbo para transmitir o som sem
// recapturar as lives que tocam no próprio Nimbo (eco).
//
//   nimbo-audio.exe exclude <pid>   tudo menos o processo e seus filhos (o próprio Nimbo)
//   nimbo-audio.exe window <hwnd>   só o aplicativo dono da janela (e seus filhos)
//   nimbo-audio.exe list            janelas minimizadas, uma por linha em JSON (jogos em tela cheia
//                                   se minimizam ao perder o foco e somem da lista do Chromium)
//   nimbo-audio.exe restore <hwnd>  traz a janela de volta (o jogo volta à tela ao ser escolhido)
//   nimbo-audio.exe info <hwnd>     retângulo da janela e do monitor dela, e se cobre o monitor
//   nimbo-audio.exe watch <hwnd>    escreve 1 quando o jogo está na frente e 0 quando sai (Alt+Tab,
//                                   minimizado ou fechado), a cada mudança, até a entrada fechar
//
// Termina quando a entrada padrão fecha (o Nimbo saiu) ou em caso de erro (código != 0).
// Compilar: csc /platform:x64 /optimize /out:nimbo-audio.exe NimboAudio.cs
using System;
using System.IO;
using System.Text;
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

        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

        static string Json(string value)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in value)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static string ProcessPath(uint pid)
        {
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return "";
            var path = new StringBuilder(1024);
            int size = path.Capacity;
            bool ok = QueryFullProcessImageName(process, 0, path, ref size);
            CloseHandle(process);
            return ok ? path.ToString() : "";
        }

        [StructLayout(LayoutKind.Sequential)]
        struct Rect
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MonitorInfo
        {
            public int cbSize;
            public Rect Monitor;
            public Rect Work;
            public uint Flags;
        }

        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);

        static string RectJson(Rect r)
        {
            return "{\"left\":" + r.Left + ",\"top\":" + r.Top + ",\"right\":" + r.Right + ",\"bottom\":" + r.Bottom + "}";
        }

        // Janela e monitor em pixels físicos, e se a janela cobre o monitor inteiro (jogo em tela cheia).
        static int WindowInfo(IntPtr hwnd)
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            Rect window;
            if (!GetWindowRect(hwnd, out window)) return Fail("janela não encontrada");
            var info = new MonitorInfo { cbSize = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info)) return Fail("monitor não encontrado");
            bool fullscreen = !IsIconic(hwnd) &&
                window.Left <= info.Monitor.Left && window.Top <= info.Monitor.Top &&
                window.Right >= info.Monitor.Right && window.Bottom >= info.Monitor.Bottom;
            Console.Out.Write("{\"fullscreen\":" + (fullscreen ? "true" : "false") +
                ",\"minimized\":" + (IsIconic(hwnd) ? "true" : "false") +
                ",\"window\":" + RectJson(window) + ",\"monitor\":" + RectJson(info.Monitor) + "}\n");
            return 0;
        }

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

        static int WatchForeground(IntPtr hwnd)
        {
            uint gamePid;
            GetWindowThreadProcessId(hwnd, out gamePid);
            var stop = new ManualResetEvent(false);
            var watcher = new Thread(() =>
            {
                try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { }
                stop.Set();
            });
            watcher.IsBackground = true;
            watcher.Start();
            int last = -1;
            do
            {
                uint foregroundPid = 0;
                IntPtr foreground = GetForegroundWindow();
                if (foreground != IntPtr.Zero) GetWindowThreadProcessId(foreground, out foregroundPid);
                // Qualquer janela do próprio jogo na frente conta (menus, launcher interno).
                int active = IsWindow(hwnd) && !IsIconic(hwnd) && foregroundPid == gamePid ? 1 : 0;
                if (active != last)
                {
                    Console.Out.Write(active + "\n");
                    Console.Out.Flush();
                    last = active;
                }
                if (!IsWindow(hwnd)) return 0;
            } while (!stop.WaitOne(250));
            return 0;
        }

        static int ListMinimized()
        {
            var output = new StringBuilder();
            EnumWindows((hwnd, _) =>
            {
                if (!IsWindowVisible(hwnd) || !IsIconic(hwnd)) return true;
                if (GetWindow(hwnd, 4) != IntPtr.Zero) return true; // tem dono: diálogo, não app
                if ((GetWindowLong(hwnd, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
                int cloaked;
                if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                var title = new StringBuilder(512);
                if (GetWindowText(hwnd, title, title.Capacity) == 0) return true;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                output.Append("{\"hwnd\":\"").Append(hwnd.ToInt64()).Append("\",\"pid\":").Append(pid)
                    .Append(",\"title\":").Append(Json(title.ToString()))
                    .Append(",\"path\":").Append(Json(ProcessPath(pid))).Append("}\n");
                return true;
            }, IntPtr.Zero);
            Console.Out.Write(output.ToString());
            return 0;
        }

        static int Fail(string message)
        {
            Console.Error.WriteLine("ERROR " + message);
            return 1;
        }

        [MTAThread]
        static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "list") return ListMinimized();
            if (args.Length == 2 && args[0] == "watch")
            {
                long watched;
                if (!long.TryParse(args[1], out watched)) return Fail("janela inválida");
                return WatchForeground(new IntPtr(watched));
            }
            if (args.Length == 2 && args[0] == "info")
            {
                long target;
                if (!long.TryParse(args[1], out target)) return Fail("janela inválida");
                return WindowInfo(new IntPtr(target));
            }
            if (args.Length == 2 && args[0] == "restore")
            {
                long target;
                if (!long.TryParse(args[1], out target)) return Fail("janela inválida");
                ShowWindow(new IntPtr(target), 9); // SW_RESTORE
                SetForegroundWindow(new IntPtr(target));
                return 0;
            }
            if (args.Length != 2) return Fail("uso: exclude <pid> | window <hwnd> | list | restore <hwnd>");
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
