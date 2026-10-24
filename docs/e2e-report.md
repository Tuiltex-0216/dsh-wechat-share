# 微信直转（dsh-wechat-share）端到端验证报告

日期：2026-10-24 · 机器：Windows 11 25H2 (26200) · DSH Desktop 0.12.1 · dsh 0.2.1-rc.2

## 主链路 e2e（已通过 ✓）

| # | 环节 | 结果 | 证据 |
|---|------|------|------|
| 1 | 微信「合并转发→其他应用」出现 **DSH Harness** 入口 | ✓ | 用户在微信列表中找到并点击（16:57 首次） |
| 2 | stub 接收 share → 写批次到 `wxshare\inbox\Ready\<batchId>\` | ✓ | manifest.json 符合 T1 契约（小写键/Z 后缀 UTC）+ files\*.zip |
| 3 | 插件 watcher 检出批次（fs.watch + 2s 轮询兜底） | ✓ | 合成批次 3.5s 内被 state 路由可见；真实批次浮层弹出 |
| 4 | GUI 浮层弹出（shell.overlay，2s 轮询 state） | ✓ | 用户截图×3：标题/批次摘要/两级列表/按钮齐全 |
| 5 | 会话列表友好标题 + 最近活跃排序 | ✓ | 截图：微信聊天转发插件/安装 dsh-gsap…/Greeting 等真实标题；空白会话隐藏（与侧栏一致） |
| 6 | 投递：uploadStream(64KB 分块) → prompt(queue, text+file 部件, AbortSignal) | ✓ | 19:11 真实批次投递成功 |
| 7 | zip 以**带附件的用户消息**到达目标会话 | ✓ | 本会话收到「微信聊天记录转发（来自微信，1 个文件，共 0.0 MB）。请解压并阅读：」+ 聊天记录_20261024_191133.zip |
| 8 | agent 解压并读取内容 | ✓ | zip 内含 聊天记录.txt：`·吴 / 2026年10月23日 20:43 / 你好` |
| 9 | 投递成功 → 批次归档 Done\<yyyyMMdd>\ | ✓ | moveToDone(delivered) |
| 10 | 忽略 → 批次归档 Done（dismissed） | ✓ | 用户 17:04 操作 + dismiss 路由实测 |

## 边界验证（Review Focus 落地）

| RF | 场景 | 结果 | 证据 |
|----|------|------|------|
| RF-5 | 投给不存在会话 | ✓ 通过 | 直接 HTTP：deliver 假 sessionId → `{ok:false, code:"session/not-found", message:"upload failed … session … not found"}`；**批次保留**（BATCH PRESERVED: true）；随后 dismiss → 批次消失；未知 batchId → 400 `batch-not-found` |
| RF-4 | 连发两批（串行） | ◐ 部分 | 两次真实转发间隔 >10min 各自独立成功；快速连发的浮层串行展示未专门压测（deliver 串行槽由代码保证：Promise 链） |
| RF-1 | DSH 关闭时转发 → 重启补弹 | ✓ 机制交付 | 静默排队 = 行为 c 交付核心：批次持久落收件箱（磁盘实证×3），DSH 启动时 startup sweep 认领 → 浮层弹出（代码 + 测试覆盖）。**自动唤醒 = OS 边界**（share target 强制 mediumIL，无法启动外部进程——probe-host-open.md 有完整实证）：DSH 关闭时转发后需手动打开 DSH（打开即弹浮层，批次不丢）；未来常驻助手可补齐 |
| 扩展名纠正 | 微信 zip 假扩展名（18/19 PNG-as-jpg） | ✓ 通过 | 20:40 生产实证：stub normalizer temp-copy 回退（微信占位目录禁写）→ 18 张 .jpg→.png，唯一真 JPEG 保留，聊天记录.txt 不动；stub.log 完整取证 |
| RF-2 | 非 zip 分享 | ○ 未测 | 需用户在微信分享一个 .txt（预期：微信侧中文错误文案「仅支持转发到 DSH 的压缩包」类，收件箱零新增） |
| RF-3 | >100MB 大文件 | ○ 未测（可选） | 流式拷贝（64KB 分块 uploadStream）无内存尖峰由代码结构保证；未实测 |

## 安装与宿主集成（验证记录）

- **ShareTarget 注册**：dev-mode `Add-AppxPackage -Register`（本机签名工具链损坏，走无签名开发者路径）；包 `DshDesktop.ShareTarget_1.0.0.0_neutral__jhd7w3x01sbrt` Status=Ok；DisplayName="DSH Harness"（无微信/WeChat 子串，过过滤）+ SupportsAnyFileType
- **插件注册（官方三层）**：`profiles\.generations\desired.json`（投影 source of truth）+ generation 目录（generation.json）+ `dsh plugin --profile web install <gen路径>`（pnpm deps/lockfile/node_modules link）
- **宿主服务集成**：webServer 路由（register 返回注销函数，已捕获 → apply 幂等）；workspaceRegistry.list()（sessionIds 形状）；sessions 快照（running/blank）；projcache（title/lastPromptAt）；fileUploads + sessionController（AbortSignal 必传）
- **测试**：node --test 三套全绿 — inbox 8/8 · deliver 5/5 · apply 9/9（合计 22 用例）；dotnet test stub 23/23（含 normalizer 嗅探/改名/碰撞/回退 + wake 解析）
- **提交链**：540f299(T1) → 7c668e3(T2) → 83d0bf3(T3) → 30bee16(T4) → ecd2981(T5) → 1aff8c0(T6) → dd5881e(T7) → ba5a95a(T8) → 6a9188c(T9) → 4c9e34d → 4ebbf43 → ac0fd8e → fe51bff → 910b28c → 22e100d → bedccd3 → 876a38d → f681762 → c99b0cd → 唤醒边界裁决（T10 修复群）

## 遗留（不阻塞交付）

1. **AXCD 签名公式未破**（本机 CNG/signtool 损坏环境）— 生产签名路径在正常机器上补齐即可；当前 dev-mode 注册依赖本机开发者模式开关（重装系统需重开）
2. **RF-1/RF-2 用户侧实测**（关机转发补弹 / 非 zip 拒绝文案）
3. 浮层正文「共 0.0 MB」— <0.05MB 的小 zip 显示 0.0（一位小数规则，符合模板；可接受）
4. 会话标题对**无 projcache 且非 blank** 的会话仍回退 ID 后缀（极端情况：从未被 GUI 投影过的活跃会话）

## 卸载

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\uninstall.ps1 -Execute
```

日志位置：`%APPDATA%\dsh-desktop\logs\harness.log`（宿主）· `%APPDATA%\dsh-desktop\harness\wxshare\logs\`（stub）· `wxshare-plugin\packaging\logs\`（构建）
