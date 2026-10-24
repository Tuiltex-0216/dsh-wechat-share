# wxshare-plugin（dsh-wechat-share）

微信「转发→其他应用」里的 **DSH Harness** 入口：把微信聊天记录的 zip 直投 DeepSeek Harness 的指定会话。

- 设计文档：`../docs/superpowers/specs/2026-10-23-wechat-share-plugin-design.md`（工作区上级）
- 实施计划：`../docs/superpowers/plans/2026-10-23-wechat-share-plugin.md`

## 目录地图

| 路径 | 职责 |
|---|---|
| `stub/` | C# .NET 8 Windows Share Target（WinRT 激活→校验→原子落盘→退出） |
| `packaging/` | MSIX 稀疏包清单、dev 证书信任、注册/注销脚本 |
| `plugin/` | DSH bundle `dsh-wechat-share`（host 半部 + client 浮层） |
| `scripts/` | ensure-dotnet / 安装 / 卸载 / 宿主开窗探测 |

## 运行位置

- 收件箱：`%APPDATA%\dsh-desktop\harness\wxshare\`（inbox\Ready|Done|Staging、logs）
- Share Target 包：`DshDesktop.ShareTarget`（Appx，ExternalLocation 指向 `stub\dist`）
