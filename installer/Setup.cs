// Lunarix custom installer / uninstaller (WPF on .NET Framework 4.8 — no extra runtime needed on Windows 10/11).
// The application payload (zip) is appended to this executable followed by a 16-byte footer:
//   "LNRXPAY1" (8 bytes ASCII) + payload length (Int64 little endian).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using Path = System.IO.Path;
using Ellipse = System.Windows.Shapes.Ellipse;
using Rectangle = System.Windows.Shapes.Rectangle;

namespace Lunarix.Setup
{
    internal static class Program
    {
        public const string AppName = "Lunarix";
        public const string ExeName = "Lunarix.exe";
        public const string UninstallerName = "Uninstall Lunarix.exe";
        public const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Lunarix";
        public static string Version = "1.0.0";

        [STAThread]
        public static int Main(string[] args)
        {
            var opts = Options.Parse(args);
            Log.Init();
            Log.Write("args: " + string.Join(" ", args));
            try
            {
                var payload = Payload.Locate();
                if (payload != null && payload.Version != null) Version = payload.Version;
                bool uninstall = opts.Uninstall || (payload == null && Path.GetFileName(Payload.SelfPath).StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase));

                if (uninstall && !opts.FromTemp && !opts.ScreenshotMode)
                {
                    // Re-launch from %TEMP% so the install folder (and this exe) can be deleted.
                    string dir = opts.Dir ?? Path.GetDirectoryName(Payload.SelfPath);
                    string tmp = Path.Combine(Path.GetTempPath(), "lunarix-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                    File.Copy(Payload.SelfPath, tmp, true);
                    int pid = Process.GetCurrentProcess().Id;
                    var forwarded = args.Where(a => !a.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase) && !a.StartsWith("/d=", StringComparison.OrdinalIgnoreCase) && !a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase))
                                        .Select(a => "\"" + a + "\"");
                    using (var done = new EventWaitHandle(false, EventResetMode.ManualReset, DoneEventName(pid)))
                    {
                        var psi = new ProcessStartInfo(tmp, "/uninstall /fromtemp /parentpid=" + pid + " " + string.Join(" ", forwarded) + " \"/dir=" + dir + "\"") { UseShellExecute = false };
                        var child = Process.Start(psi);
                        if (opts.Silent && child != null)
                        {
                            // Wait until the copy in %TEMP% has removed everything else, then exit
                            // so that it can delete this exe (it is locked while we run).
                            while (!done.WaitOne(250))
                                if (child.HasExited) return child.ExitCode;
                        }
                    }
                    return 0;
                }

                if (opts.Silent)
                {
                    if (uninstall)
                    {
                        string udir = opts.Dir ?? Installer.RegisteredDir() ?? Installer.DefaultDir;
                        Installer.Uninstall(udir, opts.RemoveData, opts, null);
                        Installer.FinishUninstall(udir, opts);
                        Installer.ScheduleSelfDelete();
                        return 0;
                    }
                    if (payload == null) { Log.Write("no payload"); return 2; }
                    Installer.Install(payload, opts.Dir ?? Installer.RegisteredDir() ?? Installer.DefaultDir, opts, null);
                    if (opts.Launch) Installer.Launch(opts.Dir ?? Installer.RegisteredDir() ?? Installer.DefaultDir);
                    return 0;
                }

                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                var win = new SetupWindow(payload, opts, uninstall);
                app.MainWindow = win.Window;
                return app.Run(win.Window);
            }
            catch (Exception e)
            {
                Log.Write("fatal: " + e);
                if (!opts.Silent) MessageBox.Show(e.Message, "Lunarix Setup", MessageBoxButton.OK, MessageBoxImage.Error);
                return 1;
            }
        }

        /// <summary>Set by the uninstaller copy in %TEMP% when the original uninstaller may exit.</summary>
        public static string DoneEventName(int pid) { return "Local\\LunarixUninstallDone-" + pid; }
    }

    // ------------------------------------------------------------------ options
    internal sealed class Options
    {
        public bool Silent, Uninstall, FromTemp, RemoveData, NoDesktop, NoShortcuts, NoRegister, ScreenshotMode;
        public bool Launch = true;
        public string Dir, Screenshot, Page, ShortcutDir;
        public int ParentPid;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var raw in args)
            {
                var a = raw.Trim();
                var l = a.ToLowerInvariant();
                if (l == "/s" || l == "/silent" || l == "--silent") o.Silent = true;
                else if (l == "/uninstall" || l == "--uninstall") o.Uninstall = true;
                else if (l == "/fromtemp") o.FromTemp = true;
                else if (l == "/removedata") o.RemoveData = true;
                else if (l == "/nodesktop") o.NoDesktop = true;
                else if (l == "/noshortcuts") o.NoShortcuts = true;
                else if (l == "/noregister") o.NoRegister = true;
                else if (l == "/nolaunch") o.Launch = false;
                else if (l.StartsWith("/d=")) o.Dir = a.Substring(3).Trim('"');
                else if (l.StartsWith("/dir=")) o.Dir = a.Substring(5).Trim('"');
                else if (l.StartsWith("/screenshot=")) { o.Screenshot = a.Substring(12).Trim('"'); o.ScreenshotMode = true; }
                else if (l.StartsWith("/page=")) o.Page = a.Substring(6);
                else if (l.StartsWith("/shortcutdir=")) o.ShortcutDir = a.Substring(13).Trim('"');
                else if (l.StartsWith("/parentpid=")) int.TryParse(a.Substring(11), out o.ParentPid);
            }
            if (o.Silent && !args.Any(x => x.ToLowerInvariant() == "/launch")) o.Launch = false;
            if (args.Any(x => x.ToLowerInvariant() == "/launch")) o.Launch = true;
            return o;
        }
    }

    internal static class Log
    {
        static string _file;
        public static void Init()
        {
            try { _file = Path.Combine(Path.GetTempPath(), "lunarix-setup.log"); File.AppendAllText(_file, "\r\n==== " + DateTime.Now.ToString("s") + " ====\r\n"); } catch { _file = null; }
        }
        public static void Write(string s)
        {
            try { if (_file != null) File.AppendAllText(_file, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n"); } catch { }
        }
    }

    // ------------------------------------------------------------------ strings
    internal static class L
    {
        static readonly bool Pl = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "pl";
        public static string T(string pl, string en) { return Pl ? pl : en; }
    }

    // ------------------------------------------------------------------ payload
    internal sealed class Payload
    {
        public long Offset;
        public long Length;
        public string Version;
        public static string SelfPath { get { return Process.GetCurrentProcess().MainModule.FileName; } }

        public static Payload Locate()
        {
            try
            {
                using (var fs = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (fs.Length < 16) return null;
                    fs.Seek(-16, SeekOrigin.End);
                    var buf = new byte[16];
                    fs.Read(buf, 0, 16);
                    if (Encoding.ASCII.GetString(buf, 0, 8) != "LNRXPAY1") return null;
                    long len = BitConverter.ToInt64(buf, 8);
                    var p = new Payload { Length = len, Offset = fs.Length - 16 - len };
                    try
                    {
                        using (var zip = p.Open())
                        {
                            var v = zip.GetEntry("resources/lunarix-version.txt");
                            if (v != null) using (var r = new StreamReader(v.Open())) p.Version = r.ReadToEnd().Trim();
                        }
                    }
                    catch { }
                    return p;
                }
            }
            catch (Exception e) { Log.Write("payload locate failed: " + e.Message); return null; }
        }

        public ZipArchive Open()
        {
            var fs = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            return new ZipArchive(new SubStream(fs, Offset, Length), ZipArchiveMode.Read, false);
        }
    }

    /// <summary>Read-only seekable window over another stream.</summary>
    internal sealed class SubStream : Stream
    {
        readonly Stream _s; readonly long _start, _len; long _pos;
        public SubStream(Stream s, long start, long len) { _s = s; _start = start; _len = len; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return _len; } }
        public override long Position { get { return _pos; } set { _pos = value; } }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            long remain = _len - _pos;
            if (remain <= 0) return 0;
            if (count > remain) count = (int)remain;
            _s.Seek(_start + _pos, SeekOrigin.Begin);
            int n = _s.Read(buffer, offset, count);
            _pos += n;
            return n;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            if (origin == SeekOrigin.Begin) _pos = offset;
            else if (origin == SeekOrigin.Current) _pos += offset;
            else _pos = _len + offset;
            return _pos;
        }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing) { if (disposing) _s.Dispose(); base.Dispose(disposing); }
    }

    // ---------------------------------------------------------------- installer
    internal static class Installer
    {
        public static string DefaultDir { get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Lunarix"); } }
        static string StartMenuLnk(Options o)
        {
            return o != null && o.ShortcutDir != null ? System.IO.Path.Combine(o.ShortcutDir, "StartMenu", "Lunarix.lnk") : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Lunarix.lnk");
        }
        static string DesktopLnk(Options o)
        {
            return o != null && o.ShortcutDir != null ? System.IO.Path.Combine(o.ShortcutDir, "Desktop", "Lunarix.lnk") : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Lunarix.lnk");
        }

        public static string RegisteredDir()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(Program.RegKey))
                {
                    var v = k == null ? null : k.GetValue("InstallLocation") as string;
                    return string.IsNullOrWhiteSpace(v) ? null : v;
                }
            }
            catch { return null; }
        }

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

        static string ProcessPath(Process p)
        {
            try { return p.MainModule.FileName; } catch { }
            IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, p.Id);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null;
            }
            finally { CloseHandle(h); }
        }

        static bool SamePath(string a, string b)
        {
            try { return string.Equals(System.IO.Path.GetFullPath(a).TrimEnd('\\'), System.IO.Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        /// <summary>The real installation (registered or default location), not a side-by-side copy.</summary>
        public static bool IsMainInstall(string dir)
        {
            var reg = RegisteredDir();
            return SamePath(dir, DefaultDir) || (reg != null && SamePath(dir, reg));
        }

        /// <summary>
        /// Closes Lunarix running from <paramref name="dir"/>. The local AI engine (llama-server in
        /// %LOCALAPPDATA%\Lunarix) is shared by the installation, so it is only stopped when
        /// <paramref name="includeEngine"/> is set — never for a side-by-side copy.
        /// </summary>
        public static void CloseRunningApp(string dir, bool includeEngine)
        {
            string prefix = dir.TrimEnd('\\') + "\\";
            string engineRoot = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lunarix") + "\\";
            foreach (var name in new[] { "Lunarix", "llama-server" })
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        string file = ProcessPath(p);
                        if (file == null) continue; // cannot tell whose process it is: leave it alone
                        bool ours = file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                            || (name == "llama-server" && includeEngine && file.StartsWith(engineRoot, StringComparison.OrdinalIgnoreCase));
                        if (!ours) continue;
                        Log.Write("closing " + name + " pid " + p.Id);
                        if (p.MainWindowHandle != IntPtr.Zero) { p.CloseMainWindow(); if (p.WaitForExit(4000)) continue; }
                        p.Kill();
                        p.WaitForExit(4000);
                    }
                    catch (Exception e) { Log.Write("close failed: " + e.Message); }
                }
            }
        }

        static void DeleteDirContents(string dir, string skip = null)
        {
            if (!Directory.Exists(dir)) return;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    foreach (var f in Directory.GetFiles(dir))
                    {
                        if (skip != null && string.Equals(f, skip, StringComparison.OrdinalIgnoreCase)) continue;
                        File.SetAttributes(f, FileAttributes.Normal);
                        File.Delete(f);
                    }
                    foreach (var d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
                    return;
                }
                catch (Exception e)
                {
                    Log.Write("cleanup retry " + attempt + ": " + e.Message);
                    Thread.Sleep(600);
                }
            }
        }

        public delegate void Progress(double fraction, string status);

        public static void Install(Payload payload, string dir, Options o, Progress progress)
        {
            dir = System.IO.Path.GetFullPath(dir);
            Log.Write("install to " + dir);
            if (progress != null) progress(0, L.T("Przygotowanie…", "Preparing…"));
            CloseRunningApp(dir, IsMainInstall(dir));
            Directory.CreateDirectory(dir);
            // remove previous version's files (user data lives in %APPDATA%, never here)
            if (File.Exists(System.IO.Path.Combine(dir, Program.ExeName))) DeleteDirContents(dir);

            using (var zip = payload.Open())
            {
                long total = Math.Max(1, zip.Entries.Sum(e => e.Length));
                long done = 0;
                var buffer = new byte[1 << 16];
                var sw = Stopwatch.StartNew();
                foreach (var entry in zip.Entries)
                {
                    string target = System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, entry.FullName));
                    if (!target.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) continue; // zip-slip guard
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target));
                    using (var src = entry.Open())
                    using (var dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                    {
                        int n;
                        while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            dst.Write(buffer, 0, n);
                            done += n;
                            if (progress != null && sw.ElapsedMilliseconds > 40) { sw.Restart(); progress(0.03 + 0.9 * done / total, entry.Name); }
                        }
                    }
                }
            }

            if (progress != null) progress(0.95, L.T("Tworzenie skrótów…", "Creating shortcuts…"));
            // uninstaller = this exe without the payload
            string uninst = System.IO.Path.Combine(dir, Program.UninstallerName);
            using (var self = new FileStream(Payload.SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var outF = new FileStream(uninst, FileMode.Create, FileAccess.Write))
            {
                var buf = new byte[1 << 16];
                long remain = payload.Offset;
                while (remain > 0)
                {
                    int n = self.Read(buf, 0, (int)Math.Min(buf.Length, remain));
                    if (n <= 0) break;
                    outF.Write(buf, 0, n);
                    remain -= n;
                }
            }
            string exe = System.IO.Path.Combine(dir, Program.ExeName);
            if (!o.NoShortcuts)
            {
                Shortcut.Create(StartMenuLnk(o), exe, dir);
                if (!o.NoDesktop) Shortcut.Create(DesktopLnk(o), exe, dir);
            }
            if (!o.NoRegister) Register(dir, exe, uninst);
            if (progress != null) progress(1, L.T("Gotowe", "Done"));
            Log.Write("install complete");
        }

        static long DirSizeKb(string dir)
        {
            try { return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024; } catch { return 0; }
        }

        static void Register(string dir, string exe, string uninst)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Program.RegKey))
            {
                k.SetValue("DisplayName", "Lunarix");
                k.SetValue("DisplayVersion", Program.Version);
                k.SetValue("Publisher", "Lunarix");
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninst + "\" /uninstall");
                k.SetValue("QuietUninstallString", "\"" + uninst + "\" /uninstall /S");
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, DirSizeKb(dir)), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static void Launch(string dir)
        {
            try
            {
                var exe = System.IO.Path.Combine(dir, Program.ExeName);
                Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = dir, UseShellExecute = true });
            }
            catch (Exception e) { Log.Write("launch failed: " + e.Message); }
        }

        public static void Uninstall(string dir, bool removeData, Options o, Progress progress)
        {
            dir = System.IO.Path.GetFullPath(dir);
            Log.Write("uninstall " + dir + " removeData=" + removeData);
            if (progress != null) progress(0.1, L.T("Zamykanie Lunarix…", "Closing Lunarix…"));
            CloseRunningApp(dir, IsMainInstall(dir) || removeData);
            if (progress != null) progress(0.3, L.T("Usuwanie plików…", "Removing files…"));
            if (File.Exists(System.IO.Path.Combine(dir, Program.ExeName)) || File.Exists(System.IO.Path.Combine(dir, Program.UninstallerName)))
            {
                // the original uninstaller may still be running (it waits for us in silent mode):
                // leave its exe for FinishUninstall instead of retrying against the lock
                string skip = o != null && o.ParentPid > 0 ? System.IO.Path.Combine(dir, Program.UninstallerName) : null;
                DeleteDirContents(dir, skip);
                if (skip == null) { try { Directory.Delete(dir, true); } catch { } }
            }
            if (o == null || !o.NoShortcuts)
            {
                foreach (var l in new[] { StartMenuLnk(o), DesktopLnk(o) })
                {
                    try { if (File.Exists(l)) File.Delete(l); } catch { }
                }
            }
            if (o == null || !o.NoRegister)
            {
                try { Registry.CurrentUser.DeleteSubKeyTree(Program.RegKey, false); } catch { }
                // notification identity (name + icon in Windows toasts) registered by the app
                try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\com.lunarix.desktop", false); } catch { }
            }
            if (removeData)
            {
                if (progress != null) progress(0.7, L.T("Usuwanie danych i modeli…", "Removing data and models…"));
                foreach (var d in new[] {
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Lunarix"),
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lunarix") })
                {
                    try { if (Directory.Exists(d)) Directory.Delete(d, true); } catch (Exception e) { Log.Write("data delete: " + e.Message); }
                }
            }
            if (progress != null) progress(1, L.T("Gotowe", "Done"));
        }

        /// <summary>
        /// Lets the original uninstaller exit (it waits in silent mode), then removes its exe and the
        /// now empty install folder. Runs in the copy started from %TEMP%.
        /// </summary>
        public static void FinishUninstall(string dir, Options o)
        {
            if (o == null || o.ParentPid <= 0) return;
            try
            {
                EventWaitHandle ev;
                if (EventWaitHandle.TryOpenExisting(Program.DoneEventName(o.ParentPid), out ev)) using (ev) ev.Set();
            }
            catch { }
            try { using (var p = Process.GetProcessById(o.ParentPid)) p.WaitForExit(15000); } catch { /* already gone */ }
            dir = System.IO.Path.GetFullPath(dir);
            string uninst = System.IO.Path.Combine(dir, Program.UninstallerName);
            for (int i = 0; i < 20 && File.Exists(uninst); i++)
            {
                try { File.SetAttributes(uninst, FileAttributes.Normal); File.Delete(uninst); }
                catch { Thread.Sleep(250); }
            }
            try { if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); } catch { }
            Log.Write("uninstall finished, folder removed: " + !Directory.Exists(dir));
        }

        public static void ScheduleSelfDelete()
        {
            try
            {
                var self = Payload.SelfPath;
                if (!System.IO.Path.GetFileName(self).StartsWith("lunarix-uninstall-", StringComparison.OrdinalIgnoreCase)) return;
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch { }
        }
    }

    internal static class Shortcut
    {
        public static void Create(string lnkPath, string target, string workDir)
        {
            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(lnkPath));
                var t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                var lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Lunarix — AI coding agent" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
                Marshal.FinalReleaseComObject(lnk);
                Marshal.FinalReleaseComObject(shell);
            }
            catch (Exception e) { Log.Write("shortcut failed " + lnkPath + ": " + e.Message); }
        }
    }

    // ------------------------------------------------------------ folder picker (modern IFileDialog)
    internal static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

        public static string Pick(IntPtr owner, string title, string start)
        {
            try
            {
                var dlg = (IFileDialog)new FileOpenDialogRCW();
                dlg.SetOptions(0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
                dlg.SetTitle(title);
                try
                {
                    string existing = start;
                    while (!string.IsNullOrEmpty(existing) && !Directory.Exists(existing)) existing = System.IO.Path.GetDirectoryName(existing);
                    if (!string.IsNullOrEmpty(existing))
                    {
                        IShellItem folder;
                        SHCreateItemFromParsingName(existing, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
                        dlg.SetFolder(folder);
                    }
                }
                catch { }
                if (dlg.Show(owner) != 0) return null;
                IShellItem result;
                dlg.GetResult(out result);
                string path;
                result.GetDisplayName(0x80058000, out path);
                return path;
            }
            catch (Exception e) { Log.Write("folder picker: " + e.Message); return null; }
        }
    }

    // ---------------------------------------------------------------- window
    internal sealed class SetupWindow
    {
        public readonly Window Window;
        readonly Payload _payload;
        readonly Options _opts;
        readonly bool _uninstall;
        string _installedDir;
        readonly Random _rnd = new Random(7);

        T E<T>(string name) where T : class { return (T)Window.FindName(name); }

        public SetupWindow(Payload payload, Options opts, bool uninstall)
        {
            _payload = payload;
            _opts = opts;
            _uninstall = uninstall;
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Lunarix.Setup.xaml"))
                Window = (Window)XamlReader.Load(s);
            try
            {
                using (var ico = Assembly.GetExecutingAssembly().GetManifestResourceStream("Lunarix.Icon.png"))
                    if (ico != null) Window.Icon = BitmapFrame.Create(ico, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            }
            catch { }
            Window.Title = uninstall ? L.T("Odinstaluj Lunarix", "Uninstall Lunarix") : L.T("Instalator Lunarix", "Lunarix Setup");
            Wire();
            Texts();
            Window.Loaded += (s, e) =>
            {
                MakeStars();
                Animate();
                if (_opts.ScreenshotMode) ScreenshotFlow();
            };
        }

        void Texts()
        {
            E<TextBlock>("WinTitle").Text = _uninstall ? L.T("Deinstalator", "Uninstaller") : L.T("Instalator", "Setup");
            E<TextBlock>("VersionText").Text = "v" + Program.Version;
            E<TextBlock>("TSub").Text = L.T("Autonomiczny agent AI do programowania. Opisujesz — Lunarix planuje, koduje, testuje i naprawia. Ty odpoczywasz.", "An autonomous AI coding agent. You describe — Lunarix plans, codes, tests and fixes. You relax.");
            E<TextBlock>("TLoc").Text = L.T("Folder instalacji", "Install location");
            E<TextBox>("PathBox").Text = Installer.RegisteredDir() ?? Installer.DefaultDir;
            E<Button>("BrowseBtn").Content = L.T("Zmień…", "Browse…");
            E<CheckBox>("DesktopCb").Content = L.T("Skrót na pulpicie", "Desktop shortcut");
            E<CheckBox>("LaunchCb").Content = L.T("Uruchom Lunarix po instalacji", "Launch Lunarix when done");
            E<Button>("InstallBtn").Content = Installer.RegisteredDir() != null ? L.T("Zaktualizuj", "Update") : L.T("Zainstaluj", "Install");
            E<Button>("OptionsBtn").Content = L.T("Opcje instalacji  ▾", "Install options  ▾");
            E<TextBlock>("TLegal").Text = L.T("Instalacja dla bieżącego użytkownika — bez uprawnień administratora. Twoje czaty, ustawienia i modele są przechowywane osobno i pozostają przy aktualizacji.", "Per-user install — no administrator rights needed. Your chats, settings and models are stored separately and survive updates.");
            E<TextBlock>("PTitle").Text = _uninstall ? L.T("Odinstalowywanie…", "Uninstalling…") : L.T("Instalowanie…", "Installing…");
            E<TextBlock>("DTitle").Text = _uninstall ? L.T("Odinstalowano", "Uninstalled") : L.T("Lunarix jest gotowy", "Lunarix is ready");
            E<TextBlock>("DSub").Text = _uninstall ? L.T("Lunarix został usunięty z tego komputera.", "Lunarix has been removed from this PC.") : L.T("Opisz, co chcesz zbudować — a potem możesz się zrelaksować.", "Describe what you want to build — then you can relax.");
            E<Button>("LaunchBtn").Content = L.T("Uruchom Lunarix", "Launch Lunarix");
            E<Button>("FinishBtn").Content = L.T("Zamknij", "Close");
            E<TextBlock>("UTitle").Text = L.T("Odinstalować Lunarix?", "Uninstall Lunarix?");
            E<TextBlock>("USub").Text = L.T("Aplikacja zostanie usunięta. Twoje projekty w folderze „Lunarix Projects” pozostaną nietknięte.", "The app will be removed. Your projects in the \"Lunarix Projects\" folder stay untouched.");
            E<CheckBox>("RemoveDataCb").Content = L.T("Usuń też moje dane (czaty, ustawienia, pobrane modele)", "Also remove my data (chats, settings, downloaded models)");
            E<Button>("UninstallBtn").Content = L.T("Odinstaluj", "Uninstall");
            E<Button>("CancelBtn").Content = L.T("Anuluj", "Cancel");
            E<TextBlock>("ETitle").Text = L.T("Coś poszło nie tak", "Something went wrong");
            E<Button>("RetryBtn").Content = L.T("Spróbuj ponownie", "Try again");
            E<Button>("ErrCloseBtn").Content = L.T("Zamknij", "Close");
            if (_uninstall) Show("PageUninstall", false);
        }

        void Wire()
        {
            E<Grid>("TitleBar").MouseLeftButtonDown += (s, e) => { if (e.ButtonState == MouseButtonState.Pressed) Window.DragMove(); };
            E<Grid>("Root").MouseLeftButtonDown += (s, e) => { if (e.OriginalSource is Grid || e.OriginalSource is Canvas || e.OriginalSource is Border) { try { Window.DragMove(); } catch { } } };
            E<Button>("MinBtn").Click += (s, e) => Window.WindowState = WindowState.Minimized;
            E<Button>("CloseBtn").Click += (s, e) => { if (!_busy) Window.Close(); };
            E<Button>("OptionsBtn").Click += (s, e) =>
            {
                var o = E<StackPanel>("Options");
                bool show = o.Visibility != Visibility.Visible;
                o.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
                E<TextBlock>("TLegal").Visibility = show ? Visibility.Collapsed : Visibility.Visible;
                if (show) FadeIn(o, 8);
                E<Button>("OptionsBtn").Content = show ? L.T("Ukryj opcje  ▴", "Hide options  ▴") : L.T("Opcje instalacji  ▾", "Install options  ▾");
            };
            E<Button>("BrowseBtn").Click += (s, e) =>
            {
                var h = new System.Windows.Interop.WindowInteropHelper(Window).Handle;
                var picked = FolderPicker.Pick(h, L.T("Wybierz folder instalacji", "Choose the install folder"), E<TextBox>("PathBox").Text);
                if (picked != null)
                {
                    if (!picked.TrimEnd('\\').EndsWith("Lunarix", StringComparison.OrdinalIgnoreCase)) picked = System.IO.Path.Combine(picked, "Lunarix");
                    E<TextBox>("PathBox").Text = picked;
                }
            };
            E<Button>("InstallBtn").Click += (s, e) => StartInstall();
            E<Button>("RetryBtn").Click += (s, e) => { if (_uninstall) StartUninstall(); else Show("PageWelcome", true); };
            E<Button>("ErrCloseBtn").Click += (s, e) => Window.Close();
            E<Button>("LaunchBtn").Click += (s, e) => { Installer.Launch(_installedDir ?? Installer.DefaultDir); Window.Close(); };
            E<Button>("FinishBtn").Click += (s, e) => Window.Close();
            E<Button>("UninstallBtn").Click += (s, e) => StartUninstall();
            E<Button>("CancelBtn").Click += (s, e) => Window.Close();
            Window.KeyDown += (s, e) => { if (e.Key == Key.Escape && !_busy) Window.Close(); };
            Window.Closed += (s, e) => { if (_uninstall) Installer.ScheduleSelfDelete(); };
        }

        bool _busy;

        void Show(string page, bool animate)
        {
            foreach (var p in new[] { "PageWelcome", "PageProgress", "PageDone", "PageUninstall", "PageError" })
                E<FrameworkElement>(p).Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;
            if (animate) FadeIn(E<FrameworkElement>(page), 14);
        }

        void FadeIn(FrameworkElement el, double dy)
        {
            var tt = new TranslateTransform(0, dy);
            el.RenderTransform = tt;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            el.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(420)) { EasingFunction = ease });
            tt.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(dy, 0, TimeSpan.FromMilliseconds(480)) { EasingFunction = ease });
        }

        void MakeStars()
        {
            var c = E<Canvas>("Stars");
            double w = 784, h = 484;
            for (int i = 0; i < 90; i++)
            {
                double r = _rnd.NextDouble() * 1.6 + 0.4;
                var star = new Ellipse { Width = r, Height = r, Fill = Brushes.White, Opacity = 0.1 + _rnd.NextDouble() * 0.5 };
                Canvas.SetLeft(star, _rnd.NextDouble() * w);
                Canvas.SetTop(star, _rnd.NextDouble() * h);
                c.Children.Add(star);
                var a = new DoubleAnimation(0.05 + _rnd.NextDouble() * 0.2, 0.4 + _rnd.NextDouble() * 0.6, TimeSpan.FromSeconds(1.5 + _rnd.NextDouble() * 3.5))
                {
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever,
                    BeginTime = TimeSpan.FromSeconds(_rnd.NextDouble() * 3)
                };
                star.BeginAnimation(UIElement.OpacityProperty, a);
            }
        }

        void Animate()
        {
            var floatT = (TranslateTransform)Window.FindName("LogoFloat");
            floatT.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(-6, 6, TimeSpan.FromSeconds(3.2)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut } });
            var caret = E<Rectangle>("Caret");
            var blink = new DoubleAnimationUsingKeyFrames { RepeatBehavior = RepeatBehavior.Forever, Duration = TimeSpan.FromSeconds(1.1) };
            blink.KeyFrames.Add(new DiscreteDoubleKeyFrame(1, KeyTime.FromTimeSpan(TimeSpan.Zero)));
            blink.KeyFrames.Add(new DiscreteDoubleKeyFrame(0.12, KeyTime.FromTimeSpan(TimeSpan.FromSeconds(0.55))));
            caret.BeginAnimation(UIElement.OpacityProperty, blink);
            var page = _uninstall ? "PageUninstall" : "PageWelcome";
            FadeIn(E<FrameworkElement>(page), 18);
            var logo = E<FrameworkElement>("LogoBox");
            var sc = (ScaleTransform)Window.FindName("LogoScale");
            var ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.35 };
            sc.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.82, 1, TimeSpan.FromMilliseconds(700)) { EasingFunction = ease });
            sc.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.82, 1, TimeSpan.FromMilliseconds(700)) { EasingFunction = ease });
            logo.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(600)));
        }

        void StartShine()
        {
            var sx = (TranslateTransform)Window.FindName("ShineX");
            sx.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(-120, 460, TimeSpan.FromSeconds(1.6)) { RepeatBehavior = RepeatBehavior.Forever });
        }

        void SetProgress(double f, string status)
        {
            Window.Dispatcher.BeginInvoke(new Action(() =>
            {
                var track = E<Grid>("BarTrack");
                double w = Math.Max(0, track.ActualWidth * Math.Max(0, Math.Min(1, f)));
                E<Border>("Bar").BeginAnimation(FrameworkElement.WidthProperty, new DoubleAnimation(w, TimeSpan.FromMilliseconds(260)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
                E<TextBlock>("PPercent").Text = Math.Round(f * 100) + "%";
                if (!string.IsNullOrEmpty(status)) E<TextBlock>("PStatus").Text = status;
            }));
        }

        void StartInstall()
        {
            if (_busy || _payload == null)
            {
                if (_payload == null) ShowError(L.T("Brak danych instalacyjnych w pliku instalatora (plik może być uszkodzony).", "The installer file contains no payload (it may be corrupted)."));
                return;
            }
            string dir = E<TextBox>("PathBox").Text.Trim();
            if (string.IsNullOrEmpty(dir)) dir = Installer.DefaultDir;
            var o = new Options { NoDesktop = E<CheckBox>("DesktopCb").IsChecked != true, Launch = E<CheckBox>("LaunchCb").IsChecked == true };
            _busy = true;
            Show("PageProgress", true);
            StartShine();
            E<TextBlock>("PDetail").Text = dir;
            Task.Run(() =>
            {
                try
                {
                    Installer.Install(_payload, dir, o, SetProgress);
                    _installedDir = dir;
                    Thread.Sleep(450);
                    Window.Dispatcher.Invoke(() =>
                    {
                        _busy = false;
                        if (o.Launch)
                        {
                            Installer.Launch(dir);
                            ShowDone(true);
                        }
                        else ShowDone(false);
                    });
                }
                catch (Exception e)
                {
                    Log.Write("install error: " + e);
                    Window.Dispatcher.Invoke(() => { _busy = false; ShowError(e.Message); });
                }
            });
        }

        void StartUninstall()
        {
            if (_busy) return;
            _busy = true;
            bool removeData = E<CheckBox>("RemoveDataCb").IsChecked == true;
            Show("PageProgress", true);
            StartShine();
            string dir = _opts.Dir ?? Installer.RegisteredDir() ?? Installer.DefaultDir;
            E<TextBlock>("PDetail").Text = dir;
            Task.Run(() =>
            {
                try
                {
                    Installer.Uninstall(dir, removeData, _opts, SetProgress);
                    Installer.FinishUninstall(dir, _opts);
                    Thread.Sleep(400);
                    Window.Dispatcher.Invoke(() => { _busy = false; ShowDone(false); });
                }
                catch (Exception e)
                {
                    Window.Dispatcher.Invoke(() => { _busy = false; ShowError(e.Message); });
                }
            });
        }

        void ShowDone(bool launched)
        {
            Show("PageDone", true);
            if (_uninstall || launched) E<Button>("LaunchBtn").Visibility = Visibility.Collapsed;
            if (launched) E<TextBlock>("DSub").Text = L.T("Lunarix właśnie się uruchamia. Miłego chillowania!", "Lunarix is starting now. Enjoy chilling!");
            var cs = (ScaleTransform)Window.FindName("CheckScale");
            var ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.5 };
            cs.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(520)) { EasingFunction = ease });
            cs.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(520)) { EasingFunction = ease });
        }

        void ShowError(string msg)
        {
            E<TextBlock>("EText").Text = msg + "\n\n" + L.T("Szczegóły: ", "Details: ") + System.IO.Path.Combine(System.IO.Path.GetTempPath(), "lunarix-setup.log");
            Show("PageError", true);
        }

        // ------------------------------------------------- screenshot mode (for automated visual checks)
        void ScreenshotFlow()
        {
            string page = (_opts.Page ?? "welcome").ToLowerInvariant();
            if (page == "options") E<Button>("OptionsBtn").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            if (page == "progress") { Show("PageProgress", false); StartShine(); E<TextBlock>("PDetail").Text = Installer.DefaultDir; SetProgress(0.62, "resources\\app.asar"); }
            if (page == "done") ShowDone(false);
            if (page == "error") ShowError("Access to the path is denied.");
            var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1600) };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                try
                {
                    var root = (FrameworkElement)Window.Content;
                    var dpi = VisualTreeHelper.GetDpi(Window);
                    double w = Window.ActualWidth, h = Window.ActualHeight;
                    var bmp = new RenderTargetBitmap((int)(w * dpi.DpiScaleX), (int)(h * dpi.DpiScaleY), 96 * dpi.DpiScaleX, 96 * dpi.DpiScaleY, PixelFormats.Pbgra32);
                    var bg = new DrawingVisual();
                    using (var ctx = bg.RenderOpen()) ctx.DrawRectangle(new SolidColorBrush(Color.FromRgb(128, 128, 128)), null, new Rect(0, 0, w, h));
                    bmp.Render(bg);
                    bmp.Render(root);
                    var enc = new PngBitmapEncoder();
                    enc.Frames.Add(BitmapFrame.Create(bmp));
                    using (var f = File.Create(_opts.Screenshot)) enc.Save(f);
                }
                catch (Exception ex) { Log.Write("screenshot failed: " + ex); }
                Window.Close();
            };
            timer.Start();
        }
    }
}
