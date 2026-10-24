# T4 探针结论：DSH 桌面端自动开窗 API

日期：2026-10-24　探针人：dsh-agent（wxshare-plugin T4）
对象：`C:\Program Files\DSH Desktop\resources\app.asar`（build 2026-10-20，Electron 壳 `out/main/index.js` 23547 行 + `out/preload/index.cjs`）

## 结论（一句话）

**存在可用唤醒路径：以无参数方式启动 `C:\Program Files\DSH Desktop\DSH Desktop.exe`。**
DSH 在运行 → 单实例锁把该次启动转为 `second-instance` 事件 → `openHarness(url, "user")` 显示并提升窗口；DSH 未运行 → 完整启动 → 开窗。已在本机实测通过。

## 证据链（main 进程源码）

### 1. 单实例 + 唤醒处理器（index.js:23489-23532）

```js
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.warn("[desktop] Another instance is already running; focusing existing window and exiting.");
  app.quit();
}
...
app.on("second-instance", (_event, argv) => {
  if (!isUserInitiatedInstance(argv)) return;          // 门 1：参数判定
  if (shouldStartInSafeMode(argv)) { ...; return; }    // 门 2：安全模式参数
  const snapshot = runtime?.snapshot();
  if (snapshot?.phase === "ready" && snapshot.url) {
    void openHarness(snapshot.url, "user").catch(showUnexpectedError);  // ← 开窗
  }
});
...
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();       // ★ Windows：关窗 = 退出进程
});
```

关键推论：**Windows 上「窗口关闭」等价于「进程不存在」**（`window-all-closed` → `app.quit()`）。不存在「进程活着但窗口藏起来」的状态，因此唤醒路径只需一种：启动 exe。

### 2. 参数判定（index.js:14617-14624）

```js
const scriptArgumentPattern = /\.[mc]?js$/i;
function isUserInitiatedInstance(argv) {
  if (argv.length === 0) return true;
  const [binary2, ...rest] = argv;
  if (binary2.includes("/Contents/Frameworks/")) return false;
  const firstArgument = rest[0];
  if (firstArgument === void 0) return true;
  return !scriptArgumentPattern.test(firstArgument);
}
```

**无参数 = 用户发起 = true**。带 `.js/.cjs/.mjs` 首参会被拒（脚本模式）。stub 启动时**不带任何参数**即可。

### 3. 开窗核心（index.js:21356-21411，openHarness）

```js
async function openHarness(url, focusIntent = "automatic") {
  if (quitting || gpuFallbackRelaunching) return;
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  ...（URL 变化时导航 + 清缓存/cookie）...
  raiseWindowWithoutStealingFocus(window, process.platform, () => app.isActive(), ...);
}
```

窗口存在 → 复用并 `raiseWindowWithoutStealingFocus`（显示 + 提升，带焦点窃取抑制）；不存在 → `createWindow()`。

### 4. 边界情况

| 场景 | 行为 |
|---|---|
| DSH 运行中，harness phase=ready | second-instance → openHarness → 窗口显示/提升 ✅（实测） |
| DSH 运行中，harness 启动早期 phase=idle | second-instance 分支不触发（无 launchHarness 调用）→ 无操作；首个实例启动完成后自会开窗 ✅ 无害 |
| DSH 未运行 | 新进程完整 bootstrap → launchHarness → 开窗 ✅ |
| 带脚本参数（xxx.js）启动 | isUserInitiatedInstance=false → second-instance 忽略（不会误唤醒）✅ |
| 安全模式参数 | 走安全模式窗口分支（与唤醒无关） |

## 实测记录（本机，2026-10-24 14:xx）

```
启动前：DSH Desktop 运行中，主窗口 handle=2690216
执行：  Start-Process 'C:\Program Files\DSH Desktop\DSH Desktop.exe'（无参数）
4 秒后：主窗口 handle 不变（2690216），第二实例进程已退出（单实例锁交接完成）
结论：  唤醒路径生效
```

## 对 wxshare stub 的集成规格（T5-T8 消费）

### 唤醒的 OS 边界（2026-10-24 实证，结论先于规格）

- **share target 形态强制 win32App+mediumIL**：MakeAppx 80080204（win32App 必须配 mediumIL）+ 部署 0x80070490（纯 UWP Application 条目拒绝 windows.shareTarget 扩展）——两条都是 OS 强制，无绕过。
- **medium IL 无法启动外部进程**：stub 内 `Process.Start`（UseShellExecute=true）启动 `C:\Program Files\DSH Desktop\DSH Desktop.exe` → Access denied（stub.log 2026-10-24 20:40 实证；runFullTrust capability 已声明但被 mediumIL 压过）。
- **后果**：唤醒只在 DSH 关闭时才有意义——恰是 mediumIL 被阻塞的场景。**stub 侧唤醒不可实现**（在此组件形态内）。
- **行为 c 的交付核心（已实现）**：静默排队——批次持久落收件箱，DSH 启动时插件 startup sweep 认领 → 浮层弹出。DSH 开着时转发 → 2s 轮询即时弹浮层（无需唤醒）。
- **未来选项（backlog）**：常驻全信任助手（Run 键自启的小型 win32 watcher，loopback 监听 stub 的 wake 信号 → 由助手启动 DSH）——新组件+新失败面，v1 不做。

### 唤醒调用规格（保留给未来常驻助手消费）

- **唤醒调用**：`ShellExecuteW(exePath, null, null, SW_SHOWNORMAL)`，exePath 解析顺序（stub 内 `DshWake.ResolveExePath` 已实现 + `--wake-probe` 诊断模式）：
  1. 运行中 DSH 进程的 `MainModule.FileName`（绕过 FS API；包上下文 File.Exists 全盲的实证教训）
  2. 注册表卸载键 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` 中 InstallLocation 含 "DSH Desktop" 的 + `DSH Desktop.exe`
  3. 回退：`C:\Program Files\DSH Desktop\DSH Desktop.exe`
- **触发时机**：share 批次落收件箱后，若 DSH 未运行 → 由常驻助手唤醒（见上）；DSH 侧插件收到投递后按需弹 toast（`dsh:notification-show` 是 renderer 侧 API，由 DSH 内插件触发，stub 不直接调用）
- **preload 桥面（备查）**：`__DSH_HOST_PATHS__`、`__DSH_DIRECTORY_PICKER__`（directory-picker:open）、`__DSH_DESKTOP_NOTIFICATION__`（dsh:notification-show/close）、harness:*（restart/open-recovery/open-in-finder/renderer-healthy）、updates:*、safe-mode:*、mobile:* —— 全部为 renderer→main IPC，**无 main 侧可编程的外部开窗 IPC**（无深链协议唤醒；`registerDesktopScheme` 是内部资源协议 desktop:// 非唤醒通道）
- **风险**：单实例行为依赖 Electron `requestSingleInstanceLock`（本机已实证）；若未来 DSH 改为常驻托盘不退出，stub 的「进程不存在才唤醒」探测需升级为「窗口不存在才唤醒」（枚举顶层窗口标题），当前不需要

## 未验证项（记录在案）

- phase=idle 边界的真实时间窗长度（启动早期秒级；对唤醒无害，未精确测量）
- 多显示器下 raiseWindowWithoutStealingFocus 的落位（源码未深读；实测单显示器正常）
