$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LauncherPath = Join-Path $RootDir "scripts/start-usage-viewer.ps1"
$IconPath = Join-Path $RootDir "public/app-icon.ico"
$AppUrl = "http://127.0.0.1:4317/"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopDir "AI Usage Viewer.lnk"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupShortcutPath = Join-Path $StartupDir "AI Usage Viewer Server.lnk"
$TaskbarShortcutPath = Join-Path $env:APPDATA "Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/AI Usage Viewer.lnk"
$PowerShellPath = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/powershell.exe"
$AppUserModelId = "MSEdge.127.0.0.1_/"

if (-not (Test-Path $LauncherPath)) {
  throw "Launcher script not found: $LauncherPath"
}
if (-not (Test-Path $IconPath)) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RootDir "scripts/generate-app-icons.ps1")
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ShortcutAppUserModel {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  private class ShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010B-0000-0000-C000-000000000046")]
  private interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  private interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
    public IntPtr p2;
  }

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PROPVARIANT pvar);

  public static void Set(string shortcutPath, string appUserModelId) {
    object link = new ShellLink();
    try {
      var persist = (IPersistFile)link;
      persist.Load(shortcutPath, 2);

      var store = (IPropertyStore)link;
      var key = new PROPERTYKEY {
        fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
        pid = 5
      };
      var value = new PROPVARIANT {
        vt = 31,
        p = Marshal.StringToCoTaskMemUni(appUserModelId)
      };

      try {
        int hr = store.SetValue(ref key, ref value);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        hr = store.Commit();
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      } finally {
        PropVariantClear(ref value);
      }

      persist.Save(shortcutPath, true);
    } finally {
      Marshal.ReleaseComObject(link);
    }
  }
}
'@

function Find-AppBrowser {
  $candidates = @(
    (Get-Command "msedge.exe" -ErrorAction SilentlyContinue).Source,
    (Get-Command "chrome.exe" -ErrorAction SilentlyContinue).Source,
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Google/Chrome/Application/chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google/Chrome/Application/chrome.exe")
  )

  return $candidates |
    Where-Object { $_ -and (Test-Path $_) } |
    Select-Object -First 1
}

function Set-OpenShortcut {
  param(
    [object] $Shortcut
  )

  # Always launch through the PowerShell launcher so a cold click (after a
  # reboot, or if the server crashed) starts the production server before opening
  # the dashboard. The launcher itself opens the Edge/Chrome app window. The
  # AppUserModelId set on the shortcut (when a browser exists) still groups that
  # app window under this pinned shortcut.
  $Shortcut.TargetPath = $PowerShellPath
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`""
  $Shortcut.WorkingDirectory = $RootDir
  $Shortcut.Description = "Start the local AI Usage Viewer and open its dashboard"
  $Shortcut.IconLocation = $IconPath
}

function Set-ShortcutAppId {
  param([string] $Path)

  if (Test-Path $Path) {
    [ShortcutAppUserModel]::Set($Path, $AppUserModelId)
  }
}

$shell = New-Object -ComObject WScript.Shell
$browserPath = Find-AppBrowser
$shortcut = $shell.CreateShortcut($ShortcutPath)
Set-OpenShortcut -Shortcut $shortcut
$shortcut.Save()
if ($browserPath) {
  Set-ShortcutAppId -Path $ShortcutPath
}

if (Test-Path $TaskbarShortcutPath) {
  $taskbarShortcut = $shell.CreateShortcut($TaskbarShortcutPath)
  Set-OpenShortcut -Shortcut $taskbarShortcut
  $taskbarShortcut.Save()
  if ($browserPath) {
    Set-ShortcutAppId -Path $TaskbarShortcutPath
  }
}

$startup = $shell.CreateShortcut($StartupShortcutPath)
$startup.TargetPath = $PowerShellPath
$startup.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`" -ServerOnly"
$startup.WorkingDirectory = $RootDir
$startup.Description = "Start the local AI Usage Viewer server at sign-in"
$startup.IconLocation = $IconPath
$startup.Save()

Write-Host "Created desktop shortcut: $ShortcutPath"
if (Test-Path $TaskbarShortcutPath) {
  Write-Host "Updated pinned taskbar shortcut: $TaskbarShortcutPath"
}
Write-Host "Created startup shortcut: $StartupShortcutPath"
