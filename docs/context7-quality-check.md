# Context7 代码质量检查报告

日期：2026-10-25 · 方法：Context7 MCP（官方最新文档）× 项目实际 API 用法逐项对照
文档源：Node.js **v24 API**（与 pinned node v24.21.0 精确匹配）· React 官方参考（react.dev）· .NET 官方文档（dotnet/docs，zip-tar-best-practices）

## 结论

**代码与当前官方文档指引完全对齐，无 🔴/🟡 文档级缺陷。** 三个核心高风险面（fs.watch 递归监听、zip 归档改写、React hooks/轮询）全部命中官方推荐模式。3 条 🟢 观察项（均为无害防御代码，保留）。

## 逐项对照

### Node.js v24（plugin/lib/*.js、plugin/index.js）

| 项目用法 | 官方文档 | 判定 |
|---|---|---|
| `fs.watch(dir, {recursive: true}, cb)`（inbox.js） | `recursive` 选项合法，"only on supported platforms"（Windows 支持）——**v24 未弃用**；新文档确认 `signal`/`persistent` 选项存在 | ✅ 合法。我们 `watchHandle.close()` 关闭 ≈ 文档的 signal 中止路径；`persistent` 默认 true 但 dispose 全关（无进程滞留，测试已实证干净退出） |
| `createReadStream(file, {highWaterMark: 64KB})` + for-await + finally destroy（deliver.js） | 文档：**默认 highWaterMark = 64*1024**；asyncIterator "chunks of size equal to the highWaterMark"；break/return/throw 即 destroy 流 | ✅ 正确。**🟢-1**：我们的 64KB 再分块 while 循环是防御性死代码（文档保证 fs 产出 ≤ highWaterMark 的块）——无害，保留（对未来 highWaterMark 调大免疫） |
| `readJsonBody` 超 1MB `req.destroy?.()`（index.js Y4） | 文档：流消费者提前终止应 destroy | ✅ 与文档一致 |
| `AbortController` 每投递一实例传给宿主 prompt（deliver.js） | 文档：signal 是流/宿主协作的标准取消机制 | ✅ 正确（且是生产崩溃的修复点：宿主无保护解引用 signal） |
| `crypto.randomUUID()`、`Buffer.subarray`、`import.meta.dirname`（node 24） | v24 均为稳定 API | ✅ |

### React（plugin/client.js）

| 项目用法 | 官方文档 | 判定 |
|---|---|---|
| 全部 hooks（4×useState/useRef/4×useEffect）在条件 `return null` **之前** | Rules of Hooks："useEffect can only be called at the top level... not within loops or conditions" | ✅ 合规（fresh reviewer 已独立验证，文档二次确认） |
| 2s 轮询 effect：`let alive = true` + cleanup `{alive=false; clearTimeout}` | 官方"Connecting to an external system"模式：setup 连接 + cleanup 断开；异步竞态用 ignore 标志 | ✅ 逐字命中官方模式（`if (alive && s && s.ok) setState(s)` = 官方 `ignore` 标志等价物） |
| StrictMode 双 setup+cleanup（dev） | 文档：cleanup 必须可重入 | ✅ 我们的 cleanup 幂等（clearTimeout + 标志），首循环被正确杀死 |
| 默认选中 effect 依赖 `[state]`（state 每 2s 轮询变对象） | 文档："object dependencies can cause Effects to re-run more often than necessary" | **🟢-2**：effect 每 2s 重跑，但 `if (sel) return` 守卫使其 O(1) 廉价退出——可接受（选中后永不重算）；理论优化 = ref 标志，不值改动 |
| 全部用户可控串（标题/文件名/错误）走 createElement 文本节点 | React 默认转义（无 dangerouslySetInnerHTML） | ✅ 无 XSS 面（fresh reviewer 已验证，文档确认默认转义语义） |
| `fetch(..., {signal: AbortSignal.timeout(5000)})`（Y3 后加） | 标准浏览器 API（文档轮询场景推荐防挂起） | ✅ |

### .NET 8（stub/*.cs）

| 项目用法 | 官方文档（zip-tar-best-practices） | 判定 |
|---|---|---|
| `ZipFile.OpenRead`（Read 模式）+ `ZipFile.Open(temp, Create)` 选择性拷贝 + swap（ZipNormalizer.Rebuild） | 官方**逐字推荐模式**："open the original in Read mode, create a new archive in Create mode, and selectively copy entries"；"Only use Update mode for archives you trust and know are small" | ✅✅ **命中官方最佳实践原文**（我们从不用 Update 模式——大/不可信归档安全） |
| using 全包裹（target/source/srcStream/dstStream/head-read） | "Always dispose ZipArchive and their streams" | ✅ 全处置 |
| 头部嗅探：`entry.Open()` 读 64B 即关 | "Check entry.Length before Open* to avoid decompressing unexpectedly large entries" | **🟢-3**：我们打开每个图像条目流（仅首块解压，64B 有界）——19 条目×首块 = 可忽略；严格做法是先查 `entry.Length` 上限再开流——当前量级下无需 |
| `ProcessStartInfo{UseShellExecute=true}` 启动外部 GUI（DshWake） | 标准 API 用法 | ✅ 用法正确（被 mediumIL 沙箱拒绝是 OS 策略非 API 误用——边界已裁决文档化） |
| CSWinRT `IShareTargetActivatedEventArgs` 薄封装（ShareActivation） | WinRT 投影标准用法 | ✅ |

## 🟢 观察项汇总（均保留现状）

1. **streamFile 再分块循环** = 防御性死代码（文档保证 fs 块 ≤ highWaterMark）
2. **默认选中 effect 依赖 [state]** = 每 2s 重跑但守卫 O(1) 退出
3. **嗅探开流未先查 entry.Length** = 量级可忽略（首块 64B 有界）

## 交叉验证

- fresh reviewer（936de070）的独立结论与本次文档对照**零冲突**：reviewer 的 🟡 清单里没有任何一项被文档对照推翻，文档对照也没有发现 reviewer 遗漏的 🔴/🟡
- 三方一致：代码 = 官方文档模式 = reviewer 认可
