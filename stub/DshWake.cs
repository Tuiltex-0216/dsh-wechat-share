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
    /// <summary>
    /// Resolve the DSH Desktop exe: running-process path → uninstall
    /// registry scan → Program Files fallback. Returns (path, diagnostics)
    /// — diagnostics names every probe and its result (the first version
    /// failed silently inside the package context and was undiagnosable).
    /// </summary>
    public static (string? Path, string Diagnostics) ResolveExePath()
    {
        var notes = new List<string>();
        // 1) a running DSH Desktop process knows its own exe path
        try
        {
            var procs = Process.GetProcessesByName("DSH Desktop");
            if (procs.Length > 0)
            {
                var p0 = procs[0];
                try
                {
                    var fn = p0.MainModule?.FileName;
                    notes.Add("process: " + (fn ?? "no-mainmodule"));
                    if (fn is not null && File.Exists(fn)) return (fn, string.Join("; ", notes));
                }
                finally { p0.Dispose(); }
            }
            else notes.Add("process: none running");
            foreach (var p in procs) p.Dispose();
        }
        catch (Exception ex) { notes.Add("process: " + ex.Message); }
        // 2) uninstall registry InstallLocation scan
        try
        {
            using var uninstall = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
            if (uninstall is null) notes.Add("registry: HKLM Uninstall not readable");
            else
            {
                var hits = 0;
                foreach (var subName in uninstall.GetSubKeyNames())
                {
                    using var sub = uninstall.OpenSubKey(subName);
                    var installLocation = sub?.GetValue("InstallLocation") as string;
                    if (string.IsNullOrWhiteSpace(installLocation)) continue;
                    if (!installLocation.Contains("DSH Desktop", StringComparison.OrdinalIgnoreCase)) continue;
                    hits++;
                    var candidate = Path.Combine(installLocation, "DSH Desktop.exe");
                    notes.Add("registry: " + installLocation + " exists=" + File.Exists(candidate));
                    if (File.Exists(candidate)) return (candidate, string.Join("; ", notes));
                }
                notes.Add("registry: " + hits + " DSH InstallLocation hit(s), no exe");
            }
        }
        catch (Exception ex) { notes.Add("registry: " + ex.Message); }
        // 3) Program Files fallback (both common roots)
        foreach (var root in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            @"C:\Program Files",
        })
        {
            if (string.IsNullOrEmpty(root)) continue;
            var candidate = Path.Combine(root, "DSH Desktop", "DSH Desktop.exe");
            notes.Add("fallback: " + candidate + " exists=" + File.Exists(candidate));
            if (File.Exists(candidate)) return (candidate, string.Join("; ", notes));
        }
        return (null, string.Join("; ", notes));
    }

    /// <summary>
    /// Launch DSH Desktop detached. Returns (started, diagnostics).
    /// ShellExecute "open": the target is a GUI app, no window flash.
    /// </summary>
    public static (bool Started, string Diagnostics) Wake()
    {
        var (exe, diag) = ResolveExePath();
        if (exe is null) return (false, diag);
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                UseShellExecute = true,   // "open" verb — detached GUI launch
                WorkingDirectory = Path.GetDirectoryName(exe)!,
            };
            Process.Start(psi);
            return (true, diag + "; launched: " + exe);
        }
        catch (Exception ex)
        {
            return (false, diag + "; launch failed: " + ex.Message);
        }
    }
}
