# dsh-wechat-share（微信直转）

把微信聊天记录转发进 DSH 会话。微信 PC「转发 → 其他应用」里的 **DSH Harness** 入口捕获合并转发的 ZIP，DSH 插件监视本地收件箱，GUI 浮层让你选择目标工作区与会话，ZIP 最终以**带文件附件的用户消息**形式到达该会话——agent 直接解压并阅读聊天记录（文本 + 图片）。

## 功能

- **微信侧**：注册一个 MSIX 分享目标，显示名为 **DSH Harness**（刻意不含 微信/WeChat 子串——微信会把含这些子串的分享目标从列表里过滤掉），出现在微信 PC 的「其他应用」列表中。
- **捕获**：stub（C#/.NET 8，WinRT 激活）校验载荷（仅接受 ZIP），按魔数纠正媒体条目扩展名（微信经常把 PNG/HEIC 字节命名为 `.jpg`，接收端按扩展名读图会全部失败），然后把批次原子落盘到 `%APPDATA%\dsh-desktop\harness\wxshare\inbox\Ready\<batchId>\`（manifest + files）。
- **DSH 侧**（本插件）：收件箱监视器（fs.watch + 2 秒轮询兜底，DSH 启动时补扫——DSH 关闭期间转发的批次不丢）、三条 web 路由（`/wxshare/api/state|deliver|dismiss`）、`shell.overlay` 浮层：批次摘要 + 工作区→会话两级列表（真实会话标题取自投影缓存、空白会话隐藏、最近活跃优先）+ 投递/忽略按钮。
- **投递**：ZIP 以 64KB 分块流式上传宿主 `fileUploads` 服务，随后作为一条排队 prompt 提交——文本部件（「微信聊天记录转发（来自微信，N 个文件，共 X MB）。请解压并阅读：」）+ 文件部件。任何一步失败，批次原样保留在 Ready 供重试（批次保留错误契约）。
- **生命周期**：投递/忽略的批次归档到 `inbox\Done\<yyyyMMdd>\`（附 `outcome.json` 记录结果）；TTL 清理（Ready 30 天、Done 7 天）。

## 环境要求

- Windows 10/11，**开启开发者模式**（本项目的构建机走无签名 dev-mode 注册路径；生产签名包需要补齐 AXCD 摘要公式，见 `packaging/` 内的说明）
- DSH Desktop（web profile；插件装入 profile 的 bundle 集合）
- 微信 PC（分享来源）

## 安装

```powershell
# 仓库根目录
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun   # 预览（默认，不改任何东西）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Execute  # 真装
```

安装器做四件事：① 构建并注册分享目标 MSIX；② 把插件包复制到哈希钉死的 generation 目录（registry 树 + web 树双写）；③ 三层注册（desired.json + generation.json + 经 `dsh plugin install` 的 pnpm 链接）；④ 验证入口可解析。卸载：`scripts\uninstall.ps1 -Execute`（严格逆序，含分享目标注销）。

安装后重启 DSH Desktop。使用：微信里选中消息 → 合并转发 → 其他应用 → **DSH Harness** → 浮层里选会话 → 投递。

## 使用注意

- **DSH 没开时转发**：批次静默排队在收件箱，下次打开 DSH 时启动补扫认领、浮层弹出，什么都不丢。（自动唤醒 DSH 在分享目标的 mediumIL 沙箱内被操作系统禁止——边界实证与未来方案见 `docs/probe-host-open.md`。）
- **转发非 ZIP**：微信侧直接收到中文拒绝文案，收件箱零新增。
- **浮层会话列表**：只显示有过对话的会话（与 DSH 侧栏同规则），标题为真实会话标题。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `index.js`、`client.js`、`lib/`、`locale/` | DSH 插件本体（host 路由 + 浮层客户端） |
| `package.json`（`dsh.bundle`）+ `cordis.patch.yml` | bundle 清单（可经 `dsh plugin add` 安装） |
| `stub/` | C#/.NET 8 Windows 分享目标（WinRT 激活 → 校验 → 扩展名纠正 → 原子落盘）+ xunit 测试 |
| `packaging/` | MSIX 清单、构建/注册脚本、签名工具链（dev-mode 路径） |
| `scripts/` | install.ps1 / uninstall.ps1（三层注册、支持 dry-run） |
| `test/` | 插件测试（node:test，22 用例） |
| `docs/` | e2e 验证报告、宿主开窗探测（唤醒 OS 边界）、Context7 质量检查 |
| `assets/` | 市场卡片图标 + 截图（`screenshots.json` 声明） |

## 开发

```bash
node --test test/                     # 插件测试（Node ≥ 20；仓库实测 pinned Node 24）
dotnet test stub/tests/               # stub 测试（.NET 8，Windows）
pwsh scripts/install.ps1 -DryRun      # 安装器预检
```

设计决策与生产实证（包括 mediumIL 唤醒边界、微信占位目录禁写的 temp 副本回退、双 generation 树真相）都在 `docs/` 里。
