using System.Diagnostics;
using Microsoft.Win32;

namespace WeChatShare.Stub;

/// <summary>
/// T4-wake — after a successful batch commit, launch DSH Desktop (no args)
/// so the single-instance lock routes the second instance into
/// openHarness(url,"user") → the window is raised (probe-host-open.md:
/// Windows window-all-closed = app.quit(), so one wake path covers all
/// states; if DSH is already running with a window, the second instance
/// exits cleanly and the main window is simply promoted).
/// Best-effort: a failure here never fails the share.
/// </summary>
public static class DshWake
{
    /// <summary>Resolve the DSH Desktop exe (uninstall key → Program Files fallback).</summary>
    public static string? ResolveExePath()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{DSH-DESKTOP-UNINSTALL-KEY}");
            // DSH Desktop's real uninstall key name varies; scan all Uninstall
            // entries for InstallLocation containing "DSH Desktop".
            using var uninstall = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
            if (uninstall is not null)
            {
                foreach (var subName in uninstall.GetSubKeyNames())
                {
                    using var sub = uninstall.OpenSubKey(subName);
                    var installLocation = sub?.GetValue("InstallLocation") as string;
                    if (string.IsNullOrWhiteSpace(installLocation)) continue;
                    if (!installLocation.Contains("DSH Desktop", StringComparison.OrdinalIgnoreCase)) continue;
                    var candidate = Path.Combine(installLocation, "DSH Desktop.exe");
                    if (File.Exists(candidate)) return candidate;
                }
            }
        }
        catch
        {
            // registry unavailable — fall through
        }
        var fallback = @"C:\Program Files\DSH Desktop\DSH Desktop.exe";
        return File.Exists(fallback) ? fallback : null;
    }

    /// <summary>
    /// Launch DSH Desktop detached. Returns true when a process was started.
    /// ShellExecute "open" with no verb-specific console: the target is a
    /// GUI app, no window flash from our side.
    /// </summary>
    public static bool Wake()
    {
        var exe = ResolveExePath();
        if (exe is null) return false;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                UseShellExecute = true,   // "open" verb — detached GUI launch
                WorkingDirectory = Path.GetDirectoryName(exe)!,
            };
            Process.Start(psi);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
