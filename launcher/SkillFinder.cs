// SkillFinder.exe: installs Skill Finder for this Windows user, keeps it up to date, starts the local server with
// the user's Node.js and opens the browser.
// Built with the C# compiler that ships with Windows (.NET Framework 4.x, C# 5 syntax only), see
// scripts/package-win.mjs for the exact command (it adds the WinForms and zip references).
//
// Layout in %LOCALAPPDATA%\SkillFinder (SKILL_FINDER_HOME overrides it):
//   SkillFinder.exe   this launcher; the desktop shortcut "Skill Finder" points here
//   app\              server, built web app and packages; replaced whole on install or update
//   data\  .env       index, search log and GitHub token; kept across versions
//   port.txt          the port picked when 4317 was taken
//   bin\              skill-finder.cmd and skill-finder (Git Bash): the terminal command, on the user's PATH;
//                     path-added.txt says it was put there once, so a plain start does not add it back
//                     (SkillFinder.exe --version prints the installed version)
//   app.prev\         the version before the last update, until the new one has answered once (then removed);
//                     update-check.txt marks that wait, skip-version.txt a version that failed and was rolled back
//   downloads\        the last update zip, kept to reinstall offline
// Started from an unzipped download, it installs itself there and makes the desktop shortcut. Started from there,
// it looks for a newer version on the download page (only while the server is off, since an update swaps app\),
// picks a free port if needed, then starts the server.
// The server binds 127.0.0.1 only. Other addresses used: the download page (updates) and nodejs.org (link only).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class SkillFinderLauncher
{
    const int MinMajor = 22;
    const int MinMinor = 20;
    const string NodeDownload = "https://nodejs.org/ko/download";
    const string UpdateBase = "https://seojin-skill-finder.pages.dev/download/";
    /// <summary>
    /// The public half of the update key (RSA 3072, scripts/signing-key.mjs): meta.json must be signed with its
    /// private half, which never leaves the publisher's PC (user decision 2026-11-02). Same key as release.ts.
    /// </summary>
    const string UpdateKeyModulus = "50og4Fe91nQ3nmlDU7rekr9MMNwiBVLBCM+7vTkq+mD0wJerPGWTcoOhgGL6iv8TQxLSv2bEBBgdQUdePolH0y93To9hM+HrVCQMhUBPmXDcfanWzFAH2XkoXJsR+oPdoESHaiFUNq34/2CzVktB4/7OPqMkJd3mUEQmq3w5HehPn4CFnPiKNM5tMG54aC9xhaFQhMqINWDFDhy/JawazHxMn5hBnlQNFZl8k9P1BzC2LbeDX9CYvqiXTs6uldBAXFbQqJ6vA0YkGsQlzvDDk/rim028c+/JRoI4j5BlRFoGZRkh7JM5+btW6+vkZBrC1hEkjB9e5eEAs5RGHWiD/IuYk06BSLFom4OsJAgN1t4eQ1hEB7gJu4rwt+RDE3NA5lkjpM+aGBEtwYC4l0P7rkRMwcZ/RKWtiFwORX55RAe+U0QqklUAS3S3L1gEP/eUBueWCCHA9Nn7EXr34avhhrmNQN0G+G7gvFiX5M48Rne1QAB125U5bSX6lqCxmIsd";
    const string UpdateKeyExponent = "AQAB";
    const int DefaultPort = 4317;
    const long MaxDownload = 50L * 1024 * 1024;

    /// <summary>
    /// Ports from 3000 to 5999 that dev servers commonly use. The picker offers the ones free right now; database,
    /// remote desktop and VNC ports (3306, 3389, 5432, 5900, ...) are not in the list.
    /// </summary>
    static readonly int[] DevPorts = {
        3000, 3001, 3002, 3003, 3004, 3005, 3030, 3100, 3200, 3300, 3333, 3456, 3500, 3600, 3700, 3800, 3900,
        4000, 4001, 4040, 4100, 4200, 4201, 4242, 4300, 4317, 4321, 4400, 4444, 4500, 4567, 4600, 4700, 4800, 4900,
        5000, 5001, 5050, 5100, 5173, 5174, 5175, 5200, 5500,
    };

    [STAThread]
    static int Main(string[] args)
    {
        string exeDir = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        string home = HomeDir();

        // `skill-finder --version` from a terminal (user request 2026-11-04): answered before the console's code page
        // and title are changed, so the terminal it ran in stays as it was. The installed app's version, or this
        // folder's when started from an unpacked download. "\n" only: Git Bash's $(...) would keep a "\r".
        if (Array.IndexOf(args, "--version") >= 0 || Array.IndexOf(args, "-v") >= 0)
        {
            string installedVersion = ReadVersion(SamePath(exeDir, home) ? Path.Combine(home, "app") : exeDir);
            if (installedVersion != null)
            {
                Console.Out.Write(installedVersion + "\n");
                return 0;
            }
            return Say(true, "Skill Finder 버전을 읽지 못했습니다. 설치가 손상되었을 수 있습니다: " + home, 1);
        }
        // anything else typed after the command would be ignored, and the app started anyway
        if (args.Length > 0 && Array.IndexOf(args, "--list-ports") < 0)
        {
            bool help = Array.IndexOf(args, "--help") >= 0 || Array.IndexOf(args, "-h") >= 0;
            return Say(!help, Usage(), help ? 0 : 2);
        }

        Console.OutputEncoding = Encoding.UTF8;
        if (Array.IndexOf(args, "--list-ports") >= 0)
        {
            foreach (int p in FreeDevPorts()) Console.WriteLine(p);
            return 0;
        }

        Console.Title = "Skill Finder";
        // the download page (Cloudflare) needs TLS 1.2, which .NET 4 does not always turn on by itself
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;

        Console.WriteLine("Skill Finder");
        Console.WriteLine("────────────────────────────────────────");

        // One launcher at a time: a second one used to delete app.new and update\ while the first was copying
        // them (project review 2026-11-02). The launcher it starts itself (Relaunch) shares the first one's turn.
        if (Environment.GetEnvironmentVariable("SKILL_FINDER_RELAUNCHED") != "1")
        {
            bool mine;
            launcherMutex = new Mutex(true, "Local\\SkillFinderLauncher", out mine);
            if (!mine)
            {
                int port = SavedPort(home);
                if (IsUp(port))
                {
                    Console.WriteLine("Skill Finder가 이미 실행 중입니다. 브라우저를 엽니다.");
                    OpenBrowser("http://127.0.0.1:" + port);
                    Thread.Sleep(1500);
                    return 0;
                }
                return Fail("Skill Finder가 이미 켜지는 중입니다(설치나 업데이트 중일 수 있습니다). 잠시 뒤 다시 실행하세요.");
            }
        }

        Cleanup(home);
        return SamePath(exeDir, home) ? Run(home) : InstallFromDownload(exeDir, home);
    }

    /// <summary>Held for the life of this launcher (and the one it starts); see Main.</summary>
    static Mutex launcherMutex;

    /// <summary>
    /// A message for a command typed in a terminal, in UTF-8 (it is Korean), then the terminal's code page put back:
    /// Console.OutputEncoding changes it for the whole window, which would garble other tools' output there.
    /// </summary>
    static int Say(bool error, string text, int exitCode)
    {
        Encoding before = null;
        try
        {
            before = Console.OutputEncoding;
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch (IOException)
        {
            // no console (output redirected without one): written as it is
        }
        // the writers are made anew when the encoding changes, so they are taken only now
        (error ? Console.Error : Console.Out).WriteLine(text);
        try
        {
            if (before != null) Console.OutputEncoding = before;
        }
        catch (IOException)
        {
        }
        return exitCode;
    }

    static string Usage()
    {
        return string.Join(Environment.NewLine, new[] {
            "사용법:",
            "  skill-finder             Skill Finder를 켜고 브라우저를 엽니다",
            "  skill-finder --version   설치된 버전을 보여 줍니다",
            "  skill-finder --help      이 도움말",
            "검색·추천 같은 읽기 명령은 npx @seojin08/skill-finder --help 를 보세요.",
        });
    }

    // ── install ────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>Started from an unzipped download: install (or upgrade) into the home folder, then run from there.</summary>
    static int InstallFromDownload(string src, string home)
    {
        if (!IsApp(src))
        {
            return Fail("프로그램 파일이 없습니다. 내려받은 압축 파일을 모두 푼 폴더에서 SkillFinder.exe를 실행하세요.");
        }
        string newVersion = ReadVersion(src);
        string app = Path.Combine(home, "app");
        string oldVersion = IsApp(app) ? ReadVersion(app) : null;
        int compared = oldVersion == null ? 1 : CompareVersions(newVersion, oldVersion);
        if (compared < 0)
        {
            Console.WriteLine("이 PC에는 더 새 버전 Skill Finder " + oldVersion + "이(가) 설치되어 있습니다. 설치된 것을 실행합니다.");
        }
        else
        {
            if (oldVersion != null && IsUp(SavedPort(home)))
            {
                return Fail("Skill Finder가 켜져 있어 바꿀 수 없습니다. 실행 중인 Skill Finder 창을 닫고 다시 실행하세요.");
            }
            // the same version again repairs an install whose files were changed or damaged (project review #4)
            Console.WriteLine(oldVersion == null
                ? "Skill Finder " + newVersion + "을(를) 설치합니다: " + home
                : compared == 0
                    ? "Skill Finder " + newVersion + "을(를) 다시 설치합니다: " + home
                    : "Skill Finder를 " + oldVersion + "에서 " + newVersion + "(으)로 바꿉니다: " + home);
            try
            {
                InstallApp(src, home, compared > 0 && oldVersion != null ? oldVersion : null);
            }
            catch (Exception e)
            {
                return Fail("설치하지 못했습니다: " + e.Message);
            }
            try
            {
                BringOldData(src, DataDir(home), EnvPath(home));
            }
            catch (Exception e)
            {
                Console.WriteLine("이전 데이터를 옮기지 못했습니다 (" + e.Message + "). 새로 시작합니다.");
            }
        }
        string exe = Path.Combine(home, "SkillFinder.exe");
        try
        {
            if (EnsureShortcut(exe, home)) Console.WriteLine("바탕화면에 'Skill Finder' 바로가기를 만들었습니다. 다음부터는 이 바로가기로 여세요.");
        }
        catch (Exception e)
        {
            Console.WriteLine("바탕화면 바로가기를 만들지 못했습니다 (" + e.Message + "). 다음부터는 " + exe + "를 실행하세요.");
        }
        TryEnsureCommand(home, true);
        Console.WriteLine("내려받은 폴더는 이제 지워도 됩니다.");
        return Relaunch(home, false);
    }

    /// <summary>
    /// Copies an unpacked app (download folder or update) into home: app\ is built beside the old one and swapped
    /// in by renames, so a failed copy leaves the old version as it was. The running launcher is renamed aside
    /// (Windows allows that, not overwriting it) and removed on a later start. `previousVersion` (an upgrade): the
    /// old app\ is kept as app.prev\ and update-check.txt asks the next start to confirm the new version answers,
    /// or to put the old one back (project review #4).
    /// </summary>
    static void InstallApp(string src, string home, string previousVersion)
    {
        Directory.CreateDirectory(home);
        string app = Path.Combine(home, "app");
        string fresh = Path.Combine(home, "app.new");
        string prev = Path.Combine(home, "app.prev");
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        CopyTree(src, fresh, true);

        string old = null;
        if (Directory.Exists(app))
        {
            old = Path.Combine(home, "app.old-" + DateTime.Now.Ticks);
            Directory.Move(app, old);
        }
        try
        {
            Directory.Move(fresh, app);
        }
        catch
        {
            if (old != null) Directory.Move(old, app);
            throw;
        }

        string exe = Path.Combine(home, "SkillFinder.exe");
        if (File.Exists(exe)) File.Move(exe, exe + ".old-" + DateTime.Now.Ticks);
        File.Copy(Path.Combine(src, "SkillFinder.exe"), exe);
        if (old != null && previousVersion != null)
        {
            if (Directory.Exists(prev)) Directory.Move(prev, Path.Combine(home, "app.old-prev-" + DateTime.Now.Ticks));
            Directory.Move(old, prev);
            File.WriteAllText(Path.Combine(home, "update-check.txt"), ReadVersion(app) + "\n" + previousVersion);
        }
        else if (old != null)
        {
            TryDeleteDir(old);
        }
    }

    /// <summary>
    /// The version installed by the last update did not answer: app.prev\ goes back in place, and the database
    /// backup that version made before changing the data (`skill-finder.db.before-<version>.bak`) replaces the
    /// changed one. That version is skipped by later update checks; a newer one is tried again.
    /// </summary>
    static bool RollBack(string home, string failedVersion, string previousVersion)
    {
        string app = Path.Combine(home, "app");
        string prev = Path.Combine(home, "app.prev");
        if (!IsApp(prev)) return false;
        try
        {
            Directory.Move(app, Path.Combine(home, "app.old-failed-" + DateTime.Now.Ticks));
            Directory.Move(prev, app);
        }
        catch (Exception e)
        {
            Console.WriteLine("이전 버전으로 되돌리지 못했습니다 (" + e.Message + ").");
            return false;
        }
        string db = Path.Combine(DataDir(home), "skill-finder.db");
        string backup = db + ".before-" + failedVersion + ".bak";
        if (File.Exists(backup))
        {
            try
            {
                string aside = db + ".failed-" + failedVersion + "-" + DateTime.Now.Ticks;
                if (File.Exists(db)) File.Move(db, aside);
                foreach (string ext in new[] { "-wal", "-shm" })
                {
                    if (File.Exists(db + ext)) File.Move(db + ext, aside + ext);
                }
                File.Copy(backup, db);
                Console.WriteLine("데이터도 업데이트 전으로 되돌렸습니다.");
            }
            catch (Exception e)
            {
                Console.WriteLine("데이터를 되돌리지 못했습니다 (" + e.Message + "). 지금 데이터로 켭니다.");
            }
        }
        try
        {
            File.WriteAllText(Path.Combine(home, "skip-version.txt"), failedVersion);
        }
        catch (Exception)
        {
            // only means the same version may be tried again next time
        }
        TryDeleteFile(Path.Combine(home, "update-check.txt"));
        Console.WriteLine("새 버전 " + failedVersion + "이(가) 켜지지 않아 " + previousVersion + "(으)로 되돌렸습니다. 이 버전은 다음 업데이트 확인에서 건너뜁니다.");
        return true;
    }

    /// <summary>Copies the app's files; at the top, never the launcher (copied apart), data or the token.</summary>
    static void CopyTree(string from, string to, bool top)
    {
        Directory.CreateDirectory(to);
        foreach (string file in Directory.GetFiles(from))
        {
            string name = Path.GetFileName(file);
            if (top && (name.StartsWith("SkillFinder.exe", StringComparison.OrdinalIgnoreCase) || name == ".env" || name == "port.txt")) continue;
            File.Copy(file, Path.Combine(to, name), true);
        }
        foreach (string sub in Directory.GetDirectories(from))
        {
            string name = Path.GetFileName(sub);
            if (top && name == "data") continue;
            CopyTree(sub, Path.Combine(to, name), false);
        }
    }

    /// <summary>"Skill Finder" on the desktop pointing at the installed launcher; true when it was not there yet.</summary>
    static bool EnsureShortcut(string target, string home)
    {
        string desktop = Environment.GetEnvironmentVariable("SKILL_FINDER_DESKTOP");
        if (string.IsNullOrEmpty(desktop)) desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string path = Path.Combine(desktop, "Skill Finder.lnk");
        bool existed = File.Exists(path);
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type linkType = link.GetType();
        linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
        linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { home });
        linkType.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "Skill Finder: Claude Code 스킬 검색·설치" });
        linkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { target + ",0" });
        linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        return !existed;
    }

    // ── the skill-finder command ───────────────────────────────────────────────────────────────────────────

    // cmd reads a running batch file by offset, and `skill-finder` stays open in it while the app runs: change this
    // text only together with a new file name, or a launcher updated meanwhile rewrites it under a running cmd
    const string CommandCmd = "@echo off\r\nrem Skill Finder: runs the installed launcher with these arguments (skill-finder --version)\r\n\"%~dp0..\\SkillFinder.exe\" %*\r\n";
    const string CommandSh = "#!/bin/sh\n# Skill Finder for Git Bash: runs the installed launcher with these arguments (skill-finder --version)\nexec \"$(dirname \"$0\")/../SkillFinder.exe\" \"$@\"\n";
    const string PathMark = "path-added.txt";

    /// <summary>
    /// `skill-finder` in new terminals (user request 2026-11-04): bin\skill-finder.cmd (cmd, PowerShell) and
    /// bin\skill-finder (Git Bash, where Claude Code runs commands) start this launcher, and bin\ goes on the
    /// user's PATH; only bin\, so nothing else in the home folder becomes a command. `always`: an install from the
    /// download adds it again, as it remakes the shortcut; a plain start adds it once (path-added.txt), so taking
    /// it off PATH by hand sticks. True when PATH was changed now.
    /// </summary>
    static bool EnsureCommand(string home, bool always)
    {
        string bin = Path.Combine(home, "bin");
        Directory.CreateDirectory(bin);
        WriteIfChanged(Path.Combine(bin, "skill-finder.cmd"), CommandCmd);
        WriteIfChanged(Path.Combine(bin, "skill-finder"), CommandSh);

        string mark = Path.Combine(home, PathMark);
        if (!always && File.Exists(mark)) return false;
        string keyName = PathKey(home);
        if (keyName == null)
        {
            if (always) Console.WriteLine("설치 폴더를 바꿔 써서(SKILL_FINDER_HOME) PATH에는 넣지 않았습니다. 명령: " + Path.Combine(bin, "skill-finder.cmd"));
            return false;
        }
        bool added;
        try
        {
            added = AddToUserPath(keyName, bin);
        }
        catch (InvalidOperationException)
        {
            // refused on purpose (a Path too long, or not text): said once, not on every start
            File.WriteAllText(mark, "");
            throw;
        }
        File.WriteAllText(mark, bin);
        if (added && keyName == "Environment")
        {
            try
            {
                AnnounceEnvironmentChange();
            }
            catch (Exception)
            {
                // Path is set; terminals then see it after the next sign-in
            }
        }
        return added;
    }

    static void WriteIfChanged(string path, string text)
    {
        if (File.Exists(path) && File.ReadAllText(path) == text) return;
        File.WriteAllText(path, text, new UTF8Encoding(false));
    }

    /// <summary>
    /// The registry key under HKEY_CURRENT_USER whose Path the command goes on: the user's environment, but only for
    /// the real install folder. A test install (SKILL_FINDER_HOME elsewhere) uses SKILL_FINDER_PATH_KEY, a throwaway
    /// key under Software\SkillFinderTest, or changes nothing.
    /// </summary>
    static string PathKey(string home)
    {
        string test = Environment.GetEnvironmentVariable("SKILL_FINDER_PATH_KEY");
        if (!string.IsNullOrEmpty(test)) return test.StartsWith("Software\\SkillFinderTest", StringComparison.OrdinalIgnoreCase) ? test : null;
        string real = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SkillFinder");
        return SamePath(home, real) ? "Environment" : null;
    }

    /// <summary>
    /// Adds `dir` at the end of the key's Path unless an entry already names it (as written or expanded). The value
    /// is read and written as it is stored: entries such as %USERPROFILE%\bin stay unexpanded and the value keeps its
    /// kind (Environment.SetEnvironmentVariable would expand them and store plain text).
    /// </summary>
    static bool AddToUserPath(string keyName, string dir)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyName))
        {
            object raw = key.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            RegistryValueKind kind = raw == null ? RegistryValueKind.ExpandString : key.GetValueKind("Path");
            if (kind != RegistryValueKind.ExpandString && kind != RegistryValueKind.String)
            {
                throw new InvalidOperationException("사용자 Path 값의 형식이 예상과 달라 바꾸지 않았습니다");
            }
            string current = (raw as string) ?? "";
            string want = dir.TrimEnd('\\');
            foreach (string entry in current.Split(';'))
            {
                string e = entry.Trim().Trim('"').TrimEnd('\\');
                if (e.Length == 0) continue;
                if (string.Equals(e, want, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(Environment.ExpandEnvironmentVariables(e).TrimEnd('\\'), want, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            string next = current.TrimEnd(';', ' ');
            next = next.Length == 0 ? want : next + ";" + want;
            // Windows reads at most 32,767 characters of an environment block entry
            if (next.Length > 32000) throw new InvalidOperationException("사용자 Path가 너무 길어 더하지 않았습니다");
            key.SetValue("Path", next, kind);
            return true;
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeoutMs, out UIntPtr result);

    /// <summary>Tells Explorer the environment changed, so terminals opened from now on get the new Path.</summary>
    static void AnnounceEnvironmentChange()
    {
        UIntPtr result;
        // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG: a window that does not answer is skipped
        SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 2000, out result);
    }

    /// <summary>The command after an install or a start; a failure only means typing the launcher's full path.</summary>
    static void TryEnsureCommand(string home, bool always)
    {
        try
        {
            if (EnsureCommand(home, always))
            {
                Console.WriteLine("터미널 명령 skill-finder를 만들었습니다(사용자 PATH에 " + Path.Combine(home, "bin") + " 추가). 새로 연 터미널에서 skill-finder --version 으로 확인할 수 있습니다.");
            }
        }
        catch (Exception e)
        {
            Console.WriteLine("터미널 명령 skill-finder를 만들지 못했습니다 (" + e.Message + "). 앱은 그대로 씁니다.");
        }
    }

    /// <summary>Runs the installed launcher in this console and waits, so closing the window still stops everything.</summary>
    static int Relaunch(string home, bool afterUpdate)
    {
        var psi = new ProcessStartInfo(Path.Combine(home, "SkillFinder.exe"));
        psi.UseShellExecute = false;
        psi.WorkingDirectory = home;
        // it runs inside this launcher's turn (the mutex this one holds)
        psi.EnvironmentVariables["SKILL_FINDER_RELAUNCHED"] = "1";
        // the new version starts as it is: no second update round in the same start
        if (afterUpdate) psi.EnvironmentVariables["SKILL_FINDER_NO_UPDATE"] = "1";
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    /// <summary>Leftovers of earlier installs and updates; whatever is still in use is tried again next time.</summary>
    static void Cleanup(string home)
    {
        if (!Directory.Exists(home)) return;
        try
        {
            foreach (string f in Directory.GetFiles(home, "SkillFinder.exe.old*")) TryDeleteFile(f);
            foreach (string d in Directory.GetDirectories(home, "app.old-*")) TryDeleteDir(d);
            TryDeleteDir(Path.Combine(home, "app.new"));
            TryDeleteDir(Path.Combine(home, "update"));
        }
        catch (Exception)
        {
            // not worth stopping for
        }
    }

    // ── update ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Looks for a newer version on the download page and installs it: the zip must match the size and SHA-256 in
    /// meta.json and unpack to a complete app of that version. Offline or any failure: false, and the current
    /// version starts as it is.
    /// </summary>
    static bool TryUpdate(string home)
    {
        string baseUrl = Environment.GetEnvironmentVariable("SKILL_FINDER_UPDATE_URL");
        if (string.IsNullOrEmpty(baseUrl)) baseUrl = UpdateBase;
        if (!baseUrl.EndsWith("/")) baseUrl += "/";
        if (!baseUrl.StartsWith("https://") && !baseUrl.StartsWith("http://127.0.0.1:")) return false;

        string current = ReadVersion(Path.Combine(home, "app"));
        string meta;
        try
        {
            meta = HttpGetString(baseUrl + "meta.json", 4000);
        }
        catch (Exception)
        {
            return false; // offline or the page is down: start as is
        }
        string latest = JsonString(meta, "version");
        string sha = JsonString(meta, "sha256");
        long bytes = JsonNumber(meta, "bytes");
        if (latest == null || current == null || CompareVersions(latest, current) <= 0) return false;
        if (sha == null || !Regex.IsMatch(sha, "^[0-9a-f]{64}$") || bytes <= 0 || bytes > MaxDownload) return false;
        if (!VerifyRelease(latest, bytes, sha, JsonString(meta, "signature"), baseUrl))
        {
            Console.WriteLine("새 버전 " + latest + "의 서명이 맞지 않아 설치하지 않습니다. 지금 버전으로 켭니다.");
            return false;
        }
        string skipFile = Path.Combine(home, "skip-version.txt");
        if (File.Exists(skipFile) && File.ReadAllText(skipFile).Trim() == latest)
        {
            Console.WriteLine("새 버전 " + latest + "은(는) 지난번에 켜지지 않아 건너뜁니다.");
            return false;
        }

        Console.WriteLine("새 버전 " + latest + "이(가) 있습니다 (지금 " + current + "). 내려받아 바꿉니다…");
        string work = Path.Combine(home, "update");
        try
        {
            TryDeleteDir(work);
            Directory.CreateDirectory(work);
            string zip = Path.Combine(work, "skill-finder-win.zip");
            Download(baseUrl + "skill-finder-win.zip", zip, bytes);
            if (new FileInfo(zip).Length != bytes) throw new Exception("내려받은 크기가 다릅니다");
            if (Sha256(zip) != sha) throw new Exception("SHA-256이 다릅니다");
            string unpacked = Path.Combine(work, "unpacked");
            ExtractSafely(zip, unpacked);
            string src = Path.Combine(unpacked, "skill-finder");
            if (!IsApp(src) || !File.Exists(Path.Combine(src, "SkillFinder.exe")) || ReadVersion(src) != latest)
            {
                throw new Exception("압축 내용이 예상과 다릅니다");
            }
            InstallApp(src, home, current);
            Console.WriteLine("Skill Finder " + latest + "(으)로 업데이트했습니다.");
            KeepDownload(home, zip, latest);
            return true;
        }
        catch (Exception e)
        {
            Console.WriteLine("업데이트하지 못했습니다 (" + e.Message + "). 지금 버전으로 켭니다.");
            return false;
        }
        finally
        {
            TryDeleteDir(work);
        }
    }

    /// <summary>
    /// Whether meta.json's signature covers this version, size and SHA-256 (RSA PKCS#1 v1.5, SHA-256; the message
    /// is release.ts releaseMessage). The launcher test signs with its own key, given in SKILL_FINDER_UPDATE_KEY,
    /// which counts only for a download page on 127.0.0.1.
    /// </summary>
    static bool VerifyRelease(string version, long bytes, string sha, string signature, string baseUrl)
    {
        if (string.IsNullOrEmpty(signature)) return false;
        string modulus = UpdateKeyModulus;
        string testKey = Environment.GetEnvironmentVariable("SKILL_FINDER_UPDATE_KEY");
        Uri page;
        // the host itself, not a prefix: "http://127.0.0.1:1@other.example/" is another host
        if (!string.IsNullOrEmpty(testKey) && Uri.TryCreate(baseUrl, UriKind.Absolute, out page) && page.Scheme == "http" && page.Host == "127.0.0.1" && string.IsNullOrEmpty(page.UserInfo))
        {
            modulus = testKey;
        }
        try
        {
            byte[] data = Encoding.UTF8.GetBytes("skill-finder-update v1\n" + version + "\n" + bytes.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" + sha);
            using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider())
            {
                rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(modulus), Exponent = Convert.FromBase64String(UpdateKeyExponent) });
                return rsa.VerifyData(data, "SHA256", Convert.FromBase64String(signature));
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>The zip of the version just installed stays in downloads\ (the one before it is removed).</summary>
    static void KeepDownload(string home, string zip, string version)
    {
        try
        {
            string dir = Path.Combine(home, "downloads");
            Directory.CreateDirectory(dir);
            foreach (string old in Directory.GetFiles(dir, "skill-finder-*.zip")) TryDeleteFile(old);
            File.Move(zip, Path.Combine(dir, "skill-finder-" + version + ".zip"));
        }
        catch (Exception)
        {
            // only a convenience
        }
    }

    static string HttpGetString(string url, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.UserAgent = "SkillFinder-launcher";
        using (var res = (HttpWebResponse)req.GetResponse())
        using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    static void Download(string url, string path, long expected)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = 30000;
        req.ReadWriteTimeout = 30000;
        req.UserAgent = "SkillFinder-launcher";
        using (var res = (HttpWebResponse)req.GetResponse())
        using (Stream input = res.GetResponseStream())
        using (FileStream output = File.Create(path))
        {
            var buffer = new byte[81920];
            long total = 0;
            int n;
            while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += n;
                if (total > expected) throw new Exception("예상보다 큰 파일입니다");
                output.Write(buffer, 0, n);
            }
        }
    }

    static string Sha256(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream f = File.OpenRead(path))
        {
            var sb = new StringBuilder();
            foreach (byte b in sha.ComputeHash(f)) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    /// <summary>Unzips, refusing any entry that would land outside the target folder.</summary>
    static void ExtractSafely(string zip, string target)
    {
        string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
        using (ZipArchive archive = ZipFile.OpenRead(zip))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string dest = Path.GetFullPath(Path.Combine(root, entry.FullName));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("압축 안의 경로가 올바르지 않습니다");
                if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                entry.ExtractToFile(dest, true);
            }
        }
    }

    static string JsonString(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    static long JsonNumber(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*([0-9]{1,12})");
        return m.Success ? long.Parse(m.Groups[1].Value) : -1;
    }

    // ── run ────────────────────────────────────────────────────────────────────────────────────────────────

    static int Run(string home)
    {
        string app = Path.Combine(home, "app");
        if (!IsApp(app))
        {
            return Fail("Skill Finder 파일이 없거나 손상되었습니다. 소개 페이지에서 zip을 다시 받아, 푼 폴더의 SkillFinder.exe를 실행하세요.");
        }
        // an install updated from an older version (which had no command) gets it on this start, once
        TryEnsureCommand(home, false);

        string version = NodeVersion();
        if (version == null)
        {
            Console.WriteLine("Node.js가 설치되어 있지 않습니다. Skill Finder를 실행하려면 Node.js " + MinMajor + "." + MinMinor + " 이상이 필요합니다.");
            Console.WriteLine("설치(PowerShell): winget install --id OpenJS.NodeJS.LTS -e");
            Console.WriteLine("Claude Code를 네이티브 설치 프로그램으로 깔았다면 Node.js가 따로 없을 수 있습니다.");
            Console.WriteLine("설치 페이지를 엽니다: " + NodeDownload);
            OpenBrowser(NodeDownload);
            return Fail("Node.js를 설치한 뒤 Skill Finder를 다시 실행하세요.");
        }
        if (!IsSupported(version))
        {
            Console.WriteLine("Node.js " + version + "이(가) 설치되어 있지만 너무 오래된 버전입니다. " + MinMajor + "." + MinMinor + " 이상이 필요합니다.");
            OpenBrowser(NodeDownload);
            return Fail("Node.js를 새 버전으로 설치한 뒤 다시 실행하세요.");
        }
        Console.WriteLine("Skill Finder " + ReadVersion(app) + " · Node.js " + version);
        // The other tools it calls, said up front instead of failing later (review 2026-11-02). Only told: the
        // launcher installs nothing itself.
        if (!OnPath("git"))
        {
            Console.WriteLine("· git이 없습니다. GitHub 저장소의 파일 목록을 읽을 때 씁니다. 설치(PowerShell): winget install --id Git.Git -e");
        }
        if (!OnPath("claude"))
        {
            Console.WriteLine("· Claude Code를 찾지 못했습니다. 스킬 설치·삭제에 씁니다(검색은 됩니다). 설치했다면 새 창에서 다시 실행하세요.");
        }

        int port = SavedPort(home);
        string url = "http://127.0.0.1:" + port;
        if (IsUp(port))
        {
            Console.WriteLine("Skill Finder가 이미 실행 중입니다. 브라우저를 엽니다: " + url);
            OpenBrowser(url);
            Thread.Sleep(1500);
            return 0;
        }

        // an update swaps app\, so only now, with the server off
        if (Environment.GetEnvironmentVariable("SKILL_FINDER_NO_UPDATE") != "1" && TryUpdate(home))
        {
            return Relaunch(home, true);
        }

        if (!PortFree(port))
        {
            Console.WriteLine("포트 " + port + "을(를) 다른 프로그램이 쓰고 있습니다. 포트를 고르는 창을 엽니다.");
            int chosen = AskPort(port);
            if (chosen == 0) return Fail("포트를 고르지 않아 Skill Finder를 켜지 않았습니다.");
            port = chosen;
            url = "http://127.0.0.1:" + port;
            SavePort(home, port);
        }

        // The index, search log and token live outside app\, so updates keep them (UI debate D-6). A location
        // already set in the environment wins.
        string dataDir = DataDir(home);
        string envPath = EnvPath(home);
        var psi = new ProcessStartInfo("node", "--disable-warning=ExperimentalWarning \"server\\src\\index.ts\"");
        psi.WorkingDirectory = app;
        psi.UseShellExecute = false; // same console window: closing it stops the server too
        psi.EnvironmentVariables["PORT"] = port.ToString();
        psi.EnvironmentVariables["SKILL_FINDER_DATA_DIR"] = dataDir;
        psi.EnvironmentVariables["SKILL_FINDER_ENV_PATH"] = envPath;
        // lets the server look for a newer version and say so on screen (it never installs anything itself)
        psi.EnvironmentVariables["SKILL_FINDER_UPDATES"] = "1";
        Process server;
        try
        {
            server = Process.Start(psi);
        }
        catch (Win32Exception e)
        {
            return Fail("서버를 시작하지 못했습니다: " + e.Message);
        }

        Console.WriteLine("서버를 켜는 중입니다. 첫 실행은 스킬 목록을 모으느라 몇 분 걸릴 수 있습니다.");
        Console.WriteLine("이 창을 닫으면 Skill Finder가 꺼집니다.");
        Console.WriteLine();

        bool opened = false;
        for (int i = 0; i < 120 && !server.HasExited; i++)
        {
            if (IsUp(port))
            {
                OpenBrowser(url);
                opened = true;
                break;
            }
            Thread.Sleep(500);
        }
        if (!opened && !server.HasExited)
        {
            Console.WriteLine("서버 응답이 늦습니다. 준비되면 브라우저에서 직접 여세요: " + url);
        }

        // The first start after an update: the new version answered (app.prev\ is no longer needed), or it did not
        // and the version before it goes back in place (project review #4).
        string check = Path.Combine(home, "update-check.txt");
        if (File.Exists(check))
        {
            string[] versions = File.ReadAllText(check).Split('\n');
            if (opened)
            {
                TryDeleteFile(check);
                TryDeleteDir(Path.Combine(home, "app.prev"));
            }
            else if (versions.Length >= 2)
            {
                try
                {
                    if (!server.HasExited) server.Kill();
                    server.WaitForExit(5000);
                }
                catch (Exception)
                {
                    // already gone
                }
                if (RollBack(home, versions[0].Trim(), versions[1].Trim())) return Run(home);
            }
        }

        server.WaitForExit();
        if (server.ExitCode != 0)
        {
            return Fail("서버가 오류로 종료되었습니다 (코드 " + server.ExitCode + "). 위의 메시지를 확인하세요.");
        }
        return 0;
    }

    // ── ports ──────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>PORT from the environment, else the port picked before (port.txt), else 4317.</summary>
    static int SavedPort(string home)
    {
        int port;
        string env = Environment.GetEnvironmentVariable("PORT");
        if (!string.IsNullOrEmpty(env) && int.TryParse(env, out port) && port > 0 && port < 65536) return port;
        try
        {
            string saved = File.ReadAllText(Path.Combine(home, "port.txt")).Trim();
            if (int.TryParse(saved, out port) && port > 0 && port < 65536) return port;
        }
        catch (Exception)
        {
            // never picked one
        }
        return DefaultPort;
    }

    static void SavePort(string home, int port)
    {
        try
        {
            Directory.CreateDirectory(home);
            File.WriteAllText(Path.Combine(home, "port.txt"), port.ToString());
        }
        catch (Exception)
        {
            // asked again next time
        }
    }

    /// <summary>Nothing listens on it (any address) and this user may bind it (Windows reserves some ranges).</summary>
    static bool PortFree(int port)
    {
        try
        {
            foreach (IPEndPoint ep in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (ep.Port == port) return false;
            }
        }
        catch (NetworkInformationException)
        {
            // fall back to trying it
        }
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.ExclusiveAddressUse = true;
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
        finally
        {
            if (listener != null) listener.Stop();
        }
    }

    static List<int> FreeDevPorts()
    {
        var free = new List<int>();
        foreach (int p in DevPorts) if (PortFree(p)) free.Add(p);
        return free;
    }

    /// <summary>A small window with the free dev ports in a drop-down; 0 when closed without choosing.</summary>
    static int AskPort(int busy)
    {
        List<int> free = FreeDevPorts();
        free.Remove(busy);
        Application.EnableVisualStyles();
        if (free.Count == 0)
        {
            MessageBox.Show("비어 있는 개발용 포트(3000~5999)를 찾지 못했습니다.\n포트를 쓰는 프로그램을 끈 뒤 다시 실행하세요.", "Skill Finder", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 0;
        }
        using (var form = new Form())
        {
            form.Text = "Skill Finder - 포트 선택";
            form.Font = new Font("Malgun Gothic", 9F);
            form.AutoScaleMode = AutoScaleMode.Font;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.TopMost = true;
            form.ClientSize = new Size(400, 176);

            var message = new Label();
            message.Text = "포트 " + busy + "은(는) 다른 프로그램이 쓰고 있습니다.\nSkill Finder를 열 포트를 고르세요. 지금 비어 있는 개발용 포트(3000~5999)만 보여 줍니다.";
            message.Location = new Point(16, 14);
            message.Size = new Size(368, 54);

            var label = new Label();
            label.Text = "포트";
            label.Location = new Point(16, 82);
            label.AutoSize = true;

            var combo = new ComboBox();
            combo.DropDownStyle = ComboBoxStyle.DropDownList;
            combo.Location = new Point(56, 78);
            combo.Width = 140;
            foreach (int p in free) combo.Items.Add(p);
            combo.SelectedIndex = 0;
            combo.AccessibleName = "포트";

            var note = new Label();
            note.Text = "고른 포트는 다음에 켤 때도 씁니다.";
            note.Location = new Point(16, 112);
            note.AutoSize = true;
            note.ForeColor = SystemColors.GrayText;

            var ok = new Button();
            ok.Text = "열기";
            ok.DialogResult = DialogResult.OK;
            ok.Location = new Point(208, 136);
            ok.Size = new Size(84, 28);

            var cancel = new Button();
            cancel.Text = "취소";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Location = new Point(300, 136);
            cancel.Size = new Size(84, 28);

            form.AcceptButton = ok;
            form.CancelButton = cancel;
            form.Controls.AddRange(new Control[] { message, label, combo, note, ok, cancel });
            return form.ShowDialog() == DialogResult.OK && combo.SelectedItem != null ? (int)combo.SelectedItem : 0;
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────

    static string HomeDir()
    {
        string home = Environment.GetEnvironmentVariable("SKILL_FINDER_HOME");
        if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SkillFinder");
        return Path.GetFullPath(home);
    }

    static string DataDir(string home)
    {
        string dir = Environment.GetEnvironmentVariable("SKILL_FINDER_DATA_DIR");
        return string.IsNullOrEmpty(dir) ? Path.Combine(home, "data") : dir;
    }

    static string EnvPath(string home)
    {
        string path = Environment.GetEnvironmentVariable("SKILL_FINDER_ENV_PATH");
        return string.IsNullOrEmpty(path) ? Path.Combine(home, ".env") : path;
    }

    static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    static bool IsApp(string dir)
    {
        return File.Exists(Path.Combine(dir, "package.json"))
            && File.Exists(Path.Combine(dir, "server", "src", "index.ts"))
            && File.Exists(Path.Combine(dir, "web", "dist", "index.html"));
    }

    /// <summary>"0.2.0" from the app's package.json; null when missing.</summary>
    static string ReadVersion(string dir)
    {
        try
        {
            Match m = Regex.Match(File.ReadAllText(Path.Combine(dir, "package.json")), "\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+)\"");
            return m.Success ? m.Groups[1].Value : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Compares "1.2.3" versions part by part; anything unreadable counts as 0.</summary>
    static int CompareVersions(string a, string b)
    {
        string[] x = (a ?? "").Split('.');
        string[] y = (b ?? "").Split('.');
        for (int i = 0; i < 3; i++)
        {
            int p, q;
            if (i >= x.Length || !int.TryParse(x[i], out p)) p = 0;
            if (i >= y.Length || !int.TryParse(y[i], out q)) q = 0;
            if (p != q) return p.CompareTo(q);
        }
        return 0;
    }

    /// <summary>
    /// Copies data\ and .env from a download folder (where 0.1.0 kept them) to the home folder, once: only while
    /// the home folder has none. The old copies stay where they are.
    /// </summary>
    static void BringOldData(string appDir, string dataDir, string envPath)
    {
        string oldData = Path.Combine(appDir, "data");
        string oldDb = Path.Combine(oldData, "skill-finder.db");
        string newDb = Path.Combine(dataDir, "skill-finder.db");
        if (File.Exists(oldDb) && !File.Exists(newDb))
        {
            Console.WriteLine("이전 데이터(스킬 목록·검색 기록)를 옮깁니다: " + dataDir);
            // everything but the database and the scratch folder first; the database last, under a temporary name,
            // so the database being there means the copy finished (a cut-off copy is simply done again)
            CopyDataDir(oldData, dataDir, "skill-finder.db");
            string partial = newDb + ".copying";
            File.Copy(oldDb, partial, true);
            File.Move(partial, newDb);
        }
        string oldEnv = Path.Combine(appDir, ".env");
        if (File.Exists(oldEnv) && !File.Exists(envPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(envPath));
            File.Copy(oldEnv, envPath);
            Console.WriteLine("GitHub 토큰 설정을 옮겼습니다: " + envPath);
        }
    }

    /// <summary>Copies a data folder, overwriting a cut-off earlier copy; skips `skip` and the `tmp` scratch folder.</summary>
    static void CopyDataDir(string from, string to, string skip)
    {
        Directory.CreateDirectory(to);
        foreach (string file in Directory.GetFiles(from))
        {
            string name = Path.GetFileName(file);
            if (name != skip) File.Copy(file, Path.Combine(to, name), true);
        }
        foreach (string sub in Directory.GetDirectories(from))
        {
            string name = Path.GetFileName(sub);
            if (name != "tmp") CopyDataDir(sub, Path.Combine(to, name), skip);
        }
    }

    static void TryDeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch (Exception)
        {
            // in use: next start
        }
    }

    static void TryDeleteFile(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception)
        {
            // in use: next start
        }
    }

    /// <summary>"v24.21.0" from `node -v`, or null when node is not on PATH.</summary>
    /// <summary>Whether a command is on PATH (where.exe also finds .cmd shims such as an npm-installed claude).</summary>
    static bool OnPath(string name)
    {
        try
        {
            var psi = new ProcessStartInfo("where.exe", name);
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                return p.HasExited && p.ExitCode == 0;
            }
        }
        catch (Win32Exception)
        {
            return true; // cannot tell: say nothing
        }
    }

    static string NodeVersion()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "-v");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(10000);
                return output.StartsWith("v") ? output : null;
            }
        }
        catch (Win32Exception)
        {
            return null;
        }
    }

    static bool IsSupported(string version)
    {
        string[] parts = version.TrimStart('v').Split('.');
        int major, minor;
        if (parts.Length < 2 || !int.TryParse(parts[0], out major) || !int.TryParse(parts[1], out minor)) return false;
        return major > MinMajor || (major == MinMajor && minor >= MinMinor);
    }

    /// <summary>
    /// Skill Finder (not just any dev server) answers on the port: its health says "app":"skill-finder", or, from
    /// 0.2.0 before that field, carries appVersion. A plain 200 on /api/health is common in web projects, and the
    /// ports offered in the picker are dev ports (project review 2026-11-02).
    /// </summary>
    static bool IsUp(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            req.Headers.Add("X-Skill-Finder", "1");
            req.Timeout = 1500;
            // Timeout covers only the headers; a server that keeps the body open must not hold the launcher
            req.ReadWriteTimeout = 1500;
            req.Proxy = null;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                if (res.StatusCode != HttpStatusCode.OK) return false;
                // Skill Finder's health is well under 1KB
                var buffer = new char[4096];
                string body = new string(buffer, 0, reader.ReadBlock(buffer, 0, buffer.Length));
                return Regex.IsMatch(body, "\"app\"\\s*:\\s*\"skill-finder\"") || (Regex.IsMatch(body, "\"ok\"\\s*:\\s*true") && body.Contains("\"appVersion\""));
            }
        }
        catch (WebException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    static void OpenBrowser(string target)
    {
        if (Environment.GetEnvironmentVariable("SKILL_FINDER_NO_BROWSER") == "1") return; // tests
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception)
        {
            Console.WriteLine("브라우저를 열지 못했습니다. 직접 여세요: " + target);
        }
    }

    static int Fail(string message)
    {
        // nothing is being installed any more: let the next launcher run while this window waits for a key
        if (launcherMutex != null)
        {
            try { launcherMutex.ReleaseMutex(); }
            catch (ApplicationException) { }
            launcherMutex = null;
        }
        Console.WriteLine();
        Console.WriteLine(message);
        Console.WriteLine("아무 키나 누르면 창이 닫힙니다.");
        try { Console.ReadKey(true); } catch (InvalidOperationException) { }
        return 1;
    }
}
