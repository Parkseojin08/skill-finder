import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { run } from './proc.ts';

// Browsers never reveal a folder's absolute path to a page, so the local server opens the OS folder dialog instead.
// The initial folder is passed through an environment variable, never spliced into the script text.

const TITLE = '프로젝트 폴더 선택';
const TIMEOUT_MS = 10 * 60 * 1000;

// Explorer-style dialog (IFileOpenDialog with FOS_PICKFOLDERS) through COM interop, owned by an invisible
// topmost window so it opens in front of the browser. Falls back to FolderBrowserDialog if the COM path fails.
const WINDOWS_PICKER_CS = `
using System;
using System.Runtime.InteropServices;
public static class SfFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRcw {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
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
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  // Bringing the dialog forward: a background process may not take the foreground on its own
  // (foreground lock), so a synthetic Alt key press unlocks SetForegroundWindow, and the dialog
  // window is made topmost once it exists.
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr hWnd, bool invert);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  static void Raise(string title) {
    uint me = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    for (int i = 0; i < 100; i++) {
      System.Threading.Thread.Sleep(50);
      IntPtr h = FindWindow("#32770", title);
      if (h == IntPtr.Zero) continue;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != me) continue;
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // HWND_TOPMOST, NOSIZE|NOMOVE|SHOWWINDOW
      FlashWindow(h, true);
      // The browser can take focus back right after the click that opened us; keep asking for ~1.5s.
      for (int k = 0; k < 10 && GetForegroundWindow() != h; k++) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);       // Alt down
        keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);  // Alt up
        BringWindowToTop(h);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(150);
      }
      return;
    }
  }

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(IntPtr owner, string title, string initial) {
    IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogRcw();
    System.Threading.Thread raiser = new System.Threading.Thread(() => Raise(title));
    raiser.IsBackground = true;
    raiser.Start();
    try {
      uint opts;
      dlg.GetOptions(out opts);
      dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      dlg.SetTitle(title);
      if (!String.IsNullOrEmpty(initial)) {
        try {
          Guid iid = typeof(IShellItem).GUID;
          IShellItem folder;
          SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
          dlg.SetFolder(folder);
        } catch (Exception) { }
      }
      if (dlg.Show(owner) != 0) return null;
      IShellItem result;
      dlg.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      Marshal.ReleaseComObject(dlg);
    }
  }
}
`;

const WINDOWS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$initial = ''
if ($env:SF_INITIAL_DIR -and (Test-Path -LiteralPath $env:SF_INITIAL_DIR -PathType Container)) { $initial = $env:SF_INITIAL_DIR }
# Invisible (fully transparent) topmost owner at the screen centre, so the dialog opens centred and above other windows.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
try {
  Add-Type -TypeDefinition @'
${WINDOWS_PICKER_CS}
'@
  $picked = [SfFolderPicker]::Pick($owner.Handle, '${TITLE}', $initial)
} catch {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '${TITLE}'
  $dialog.ShowNewFolderButton = $true
  if ($initial) { $dialog.SelectedPath = $initial }
  $picked = $null
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dialog.SelectedPath }
}
$owner.Close()
if ($picked) { [Console]::Out.Write($picked) }
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function validDir(p: string | undefined | null): string | undefined {
  if (!p || !isAbsolute(p) || /[\0\r\n]/.test(p)) return undefined;
  try {
    return statSync(p).isDirectory() ? p : undefined;
  } catch {
    return undefined;
  }
}

export class FolderPickerUnavailable extends Error {}

/** Opens the native folder dialog; resolves the chosen absolute path, or null when cancelled. */
export async function pickFolder(initial?: string | null): Promise<string | null> {
  const env = { ...process.env, SF_INITIAL_DIR: validDir(initial) ?? '' };
  let result;
  if (process.platform === 'win32') {
    result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(WINDOWS_SCRIPT)], {
      env,
      timeoutMs: TIMEOUT_MS,
    });
  } else if (process.platform === 'darwin') {
    const script = `set p to system attribute "SF_INITIAL_DIR"
if p is not "" then
  POSIX path of (choose folder with prompt "${TITLE}" default location (POSIX file p))
else
  POSIX path of (choose folder with prompt "${TITLE}")
end if`;
    result = await run('osascript', ['-e', script], { env, timeoutMs: TIMEOUT_MS });
  } else {
    const start = env.SF_INITIAL_DIR ? `${env.SF_INITIAL_DIR}/` : '';
    try {
      result = await run('zenity', ['--file-selection', '--directory', `--title=${TITLE}`, ...(start ? [`--filename=${start}`] : [])], { env, timeoutMs: TIMEOUT_MS });
    } catch {
      try {
        result = await run('kdialog', ['--getexistingdirectory', env.SF_INITIAL_DIR || '.', '--title', TITLE], { env, timeoutMs: TIMEOUT_MS });
      } catch {
        throw new FolderPickerUnavailable('zenity 또는 kdialog가 없어 폴더 선택 창을 열 수 없습니다');
      }
    }
  }
  const raw = result.stdout.trim();
  if (!raw) return null;
  // macOS returns "/path/"; keep drive roots ("C:\") and "/" intact.
  const chosen = /^([A-Za-z]:[\\/]|\/)$/.test(raw) ? raw : raw.replace(/[\\/]+$/, '');
  return validDir(chosen) ?? null;
}
