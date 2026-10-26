# dsh-auto-context-compress

DSH 插件：**主动识别每个会话的上下文压力，在裁剪上下文之前先向用户展示详情并请求确认。**

已适配 **DSH 0.2.1（`0.2.1-rc.2` 起）**，同时支持 **Web** 与 **桌面端（Electron）**：
两端共用同一套 `dsh-web-app` 宿主组合；桌面端从 `dsh-app://app/` 加载页面，并把同源的
`api/...` 请求经 IPC 转发到 loopback webServer，因此下面这条 host 路由在两端都可达。

它只做一件事，但做在前端：在模型请求之前把「超长的工具输出」这一最容易回收、
且**完全不需要模型调用**的部分收掉，并且每一次改写都要你点过确认。

## 30 秒上手

### Web profile

```sh
# 1. 把本目录放到一个不会被升级覆盖的位置，然后安装进你的 web profile
#    （把 <本目录的绝对路径> 换成本仓库的实际位置）
dsh plugin --profile web add "<本目录的绝对路径>"

# 2. 重启 DSH —— bundle 层只在启动时装载，不重启不生效

# 3. 确认它活着：返回 JSON 就对了，返回 404 说明还没装载
curl "http://127.0.0.1:3080/api/auto-context-compress"
```

### 桌面端（DeepSeek Harness Desktop）

桌面端使用 `~/.dsh/profiles/desktop` 这个 profile，而不是 `web`。先安装随桌面端附带的
`dsh` 命令（菜单栏 →「管理 dsh 命令」），然后：

```sh
dsh plugin --profile desktop add "<本目录的绝对路径>"
```

装完后**完全退出并重新启动桌面端**。桌面端默认由系统分配端口（不是 3080），所以不要用
固定端口 curl；直接看右上角的浮动读数窗，或从 `capabilities.platform` 确认读到的是 `desktop`。
桌面端也可以在「插件」页查看/启停这个 bundle（包安装操作由桌面端外壳负责）。

装完之后**什么都不用做**：上下文压力越过路由模型窗口的 50% 时，你下一次模型请求**之前**
会弹一张确认卡，列明将被裁剪的每一条内容与预览，你点「确认裁剪」它才动手。
右上角还会出现一个跟随当前对话的浮动读数窗。

> **前提**：DSH ≥ `0.2.1-rc.2`（`package.json` 的 `engines.dsh` 已声明），且 profile 带
> **web carrier** —— Web 与桌面端都带。没有 web carrier 的 headless profile 不要装
> （那一行永远不激活，而「已启用但未激活」会让启动失败）。

安装细节、手工安装法与卸载见 [安装](#安装)；日常使用、参数与排障见 [怎么使用](#怎么使用)。

## 跨对话适配：按会话 id 寻址，而不是「当前对话」

本插件不存在「当前对话」这个概念，机制与 `dsh-token-usage-hud` 同源：

- **每个会话的状态记在以 `session.id` 为键的 Map 里**，不是用对象标识、也不是单个全局记录。
- **挂载时从 `ctx.get("sessions").list()` 播种**，所以本插件装载之前就已存在的对话也立刻有记录，
  不必等它先跑一轮才有状态。
- **注册一条 host 路由**，任何读取方都能按 id 取用某个对话的状态，或只对那个对话预约一次裁剪：

  ```
  GET /api/auto-context-compress                                     列出每个对话的容量占用
  GET /api/auto-context-compress?session=<sessionId>                 取该对话的完整状态 + 容量
  GET /api/auto-context-compress?session=<sessionId>&force=prune     只对该对话预约裁剪
  GET /api/auto-context-compress?session=<sessionId>&force=both      裁剪并在仍需时升级摘要
  ```

  loopback-only，与 HUD 的 `/api/token-usage/stats` 同一道围栏。不带 `session` 不返回错误，
  而是**列出全部对话的容量读数**（见下节）。

  > **桌面端与路径前缀**：这条路由注册在 host 上是绝对路径 `/api/auto-context-compress`；
  > 浮动窗口从页面自身 origin 用**相对路径** `api/auto-context-compress` 请求。Web 以
  > `--public-url` 挂在路径前缀下时，前缀由反向代理剥掉；桌面端则由 `dsh-app://app/`
  > 的协议处理器把同源请求经 IPC 转发到 loopback host。两种情况下 host 看到的都是同一条
  > 绝对路由。

## 上下文容量使用检测（按对话）

照 `dsh-token-usage-hud` 的 `readContextProjection` 来做，读的是同一个数据源：

```js
ctx.sessionProjections.snapshot(session).values.contextPressure
```

也就是**界面里输入框下方那个占用条渲染的同一份投影**，所以读数与你在界面上看到的一致，
而不是另算一套。

每条读数包含：

| 字段 | 含义 |
|---|---|
| `usedTokens` | 下一次请求的 prompt 预计成本；取 `projectedTokens`，缺失时退回 `pressureTokens`（与 HUD 同一取舍） |
| `pressureTokens` | 最近一次由提供方回报的真实 prompt 大小 |
| `projectedTokens` | 在上次回报的基础上，加上表面增减的重估 |
| `contextWindow` | 该路由模型已知的窗口容量；无适配器声明时为 `null` |
| `ratio` | `usedTokens / contextWindow` |
| `level` | `ok` / `soft` / `hard` —— 按**本行自己的阈值**分类，直接告诉你这个对话离压缩还有多远；无窗口时为 `unknown` |
| `breakdown` | 同一份快照里的 `contextBreakdown`：`systemTokens` / `toolsTokens` / `messageTokens`，说明窗口被什么占着 |

关键点是**读数在读取时现算**，不依赖该对话是否自插件装载以来跑过一轮：任何活着的对话都能
立刻给出容量。已经持久化但当前不是活会话的（冷会话）没有投影可读，此时返回
`exists: false` / `capacity: null`，**不会编造一个读数**。

### 触发判定与显示读数刻意分开

压缩的触发用的是 `ctx.tokenMeter.measure().totalTokens`，不是投影的 `projectedTokens`——
因为那是该会话自己的压缩后端定价时用的同一个输入，这样本插件的阈值与后端阈值才一致。
两个数都会出现在读接口里，任何分歧都看得见，而不是被藏起来。

- `agent/pre-step` 是 host 平面监听器，而 `dsh-scope` 的载体过滤器明确「全局准入未打标签的
  监听器」——`scopeTarget` 里那行 `if (tag === void 0) return true`。所以这一个监听器收得到
  **进程内每个会话**的 pre-step，包括你刚切换过去的那个。压缩资格只看该会话自己的预设是否
  挂载了压缩服务，与「哪个对话正被打开」无关。

结果就是：切换对话框不会影响功能，也不需要任何客户端参与。

## 它解决什么问题

DSH 的预设（`code` / `cordis` / `standard`）已经挂载了
`@deepseek-ai/dsh-compaction-basic`，默认在上下文用量达到**窗口 80%** 时做一次
LLM 摘要压缩。那是最后一道防线，代价是一次额外的模型调用，而且是在已经很紧张的时候才动手。

现有实现里有一个顺序细节：`compactIfNeeded` 先比较压力是否越过阈值，**越过之后**才调用
`toolResultPruner` 裁剪工具输出（`lib/index.js` 中 `if (measurement.totalTokens < spec.thresholdTokens) return null;`
在 `prune.pruneSession(...)` 之前）。也就是说，零成本的裁剪被排在了昂贵的摘要之后。

本插件把这一步提前到 **50%**，于是绝大多数时候压力根本走不到 80%，摘要也就不会被触发。

## 一次请求前的完整流程

1. `agent/pre-step` 触发，用 `ctx.tokenMeter.measure(session)` 读出该会话真实的请求压力。
2. 压力 ≥ `softRatio × 上下文窗口` 时，通过 `ctx.sessionQuery.readSurface(sessionId)` 取一份
   **克隆的**当前模型表面（不触碰会话内部活对象）。
3. 对每一条 `tool/result` 调用 `pruner.pruneContent(content)`，只保留**确实会被收缩**的那些，
   得到候选清单与合计字符数。
4. **在改动任何东西之前**弹出一张确认卡：压力数值、候选条数、合计字符数，以及每一条的
   seq / 工具名 / callId / 字符数变化，和「保留开头 / 中间将被替换为省略标记 / 保留结尾」的预览。
5. 你选 **确认裁剪** 才调用 `pruner.pruneSession(session)`；选 **跳过本次** 则什么都不做，
   下一轮压力达标时会再次询问；选 **关闭自动压缩** 则本次不裁剪并停用，直到进程重启。

同一个回合内**只问一次**，不会每一步都弹卡片。

## 为什么可以放心确认

裁剪改写的只是**下一次请求实际看到的模型上下文**：长工具结果的中间段被换成
`[... tool result middle pruned ...]` 标记，开头与结尾保留。

**原始事件完整保留在会话日志中。** 会话日志是 append-only 的，裁剪写入的是一个带
`surfaceOp: { op: 'replace' }` 的**替换**节点并引用被遮蔽的原始 seq，原事件没有被删除，
依然可以通过日志回放与 `sessionQuery` 读回来。所以确认裁剪不是销毁数据，而是决定
「本轮上下文里还要不要带着这段原文」。

## 失败一律保守

任何一步出问题都退化为**什么都不裁剪**，这个插件永远不会在没有拿到确认的情况下改动上下文：

| 情况 | 行为 |
|---|---|
| `userQuestions` 未挂载（没有提问通道） | 不裁剪，记录原因 |
| 等待确认超时（`confirmTimeoutMs`） | 撤回卡片，不裁剪，下一轮重新询问 |
| 提问抛错（含子 agent 无人类应答者） | 不裁剪，记录原因 |
| 回答无法解析 / 用户填了自定义文本 | 按「跳过本次」处理 |
| `tokenMeter` 测量失败 | 不裁剪 |
| 会话预设既没挂 `compaction` 也没挂 `toolResultPruner` | 跳过该会话 |

## 配置

写在 `cordis.patch.yml` 的行里。未知键会在装载时报错，不会被静默忽略。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；确认卡片的第三个选项也会在运行时关掉它 |
| `confirm` | `true` | **是否询问。设为 `false` 就退回到静默裁剪——正是本插件想要取代的行为** |
| `confirmTimeoutMs` | `120000` | 确认卡的等待上限；超时按「不裁剪」处理。`0` 表示一直等 |
| `softRatio` | `0.5` | 裁剪层阈值，占路由模型上下文窗口的比例 |
| `escalate` | `false` | 是否把摘要层也交给本插件驱动 |
| `escalateRatio` | `0.75` | 摘要层阈值（仅 `escalate: true` 时生效） |
| `fallbackSoftTokens` / `fallbackHardTokens` | `64000` / `96000` | 拿不到窗口容量时的绝对兜底 |
| `maxDetailCandidates` | `8` | 确认卡里逐条详列的上限，其余合并为条数 |
| `previewHeadChars` / `previewTailChars` | `220` / `120` | 每条预览保留的开头 / 结尾字符数 |

`escalate` 默认 **关闭**：`compactIfNeeded` 内部仍会执行摘要后端自己的阈值判定
（`compaction-basic` 是 0.8），所以从 0.75 处调用它、在 0.75–0.80 之间通常只是空转。
本插件默认不越权接管摘要，只负责把压力挡在 80% 之前。

## 安装

DSH 的插件以 **bundle** 形式装载：一个包，加上它自己的 `cordis.patch.yml` 补丁层，
再把包名注册进 profile 清单的 `dsh.profile.bundles`。

> ### ⚠️ 不要用 `npm install` 安装本插件
>
> 如果你的 profile 由 **pnpm** 管理（目录里有 `pnpm-lock.yaml`，`node_modules/.modules.yaml`
> 是 pnpm 的标记），在一个**零依赖**的插件上跑 `npm install` 实测会打印
> **"added 175 packages"** —— npm 会按自己的规则重建整棵依赖树，可能把漂移过的包换成
> registry 版本，**破坏原本 pnpm 解析出的版本组合，进而让 DSH 起不来**。
> 这是实际发生过一次的事故，不是理论风险。

### 做法 A：用 DSH 自己的安装器（推荐）

`dsh plugin --profile <name> add ...` 会在 profile 目录里调用 **pnpm**。若 `pnpm` 不在 PATH 上，
先用 corepack 让它可用：

```sh
corepack pnpm --version          # 确认 corepack 能拉出 pnpm
dsh plugin --profile web add "<本目录的绝对路径>"       # Web
dsh plugin --profile desktop add "<本目录的绝对路径>"   # 桌面端
```

桌面端自带 `dsh` 命令（菜单栏 →「管理 dsh 命令」）；装好后就是 PATH 上的 `dsh`。
桌面端的包操作由外壳持有，**先在应用完全退出时执行安装，装完再启动**；运行中的桌面端
不会热替换这个包。

> **0.2.1 版本闸门**：插件管理器和 CLI 会先读 `package.json` 的 `engines.dsh`
> （本包为 `>=0.2.1-rc.2 <0.3.0-0`），再决定是否允许安装。若你运行的是更新的
> 0.3.x 线而被拒绝，先升级本插件，或用
> `dsh plugin --profile <name> allow-version dsh-auto-context-compress@0.3.0 --dsh-version <runtime> --accept-risk`
> 显式放行。

### 做法 B：手工两项最小改动（不惊动包管理器）

bundle 的解析只需要两件事：清单里有这个名字，以及 `node_modules` 里能按包名解析到它
（`file:` 依赖在 npm/pnpm 下都是一个**链接**）。所以可以只做两处改动：

- Web profile 在 `~/.dsh/profiles/web`。
- 桌面端 profile 在 `~/.dsh/profiles/desktop`，其 `bundles` 已包含
  `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（以及你自己装的 bundle）；
  把本包**追加到列表末尾**即可。修改前先完全退出桌面端。
- 桌面端目录若由外壳管理，手工改动后它会按自己的清单重新校验；不想冒险就直接用做法 A。

1. 在 profile 清单 `<profile 目录>/package.json` 里加两处（把路径换成你放本目录的位置）：

   ```json
   "dependencies": {
     "dsh-auto-context-compress": "file:<本目录的绝对路径>"
   },
   "dsh": {
     "profile": {
       "bundles": [
         "...",
         "dsh-auto-context-compress"
       ]
     }
   }
   ```

2. 建立链接（**只在缺失时**创建。不要对已有链接用 `Remove-Item -Recurse`——
   旧版 PowerShell 会顺着链接把**目标目录的内容**一起删掉）：

   ```powershell
   $link = "<profile 目录>\node_modules\dsh-auto-context-compress"
   if (-not (Test-Path $link)) {
     New-Item -ItemType Junction -Path $link -Target "<本目录的绝对路径>"
   }
   ```

3. 验证加载器能解析它（在 profile 目录内执行）：

   ```sh
   node --input-type=module -e "await import('dsh-auto-context-compress')"
   ```

4. **重启 DSH。** bundle 层只在启动时装载，不重启不会生效。

行 `id` 必须在所有 bundle 层里唯一；`name` 必须是包名（loader 与 client-module 扫描都按包名解析）。

### 卸载 / 回滚

把清单里那两行删掉，再移除链接即可（本目录的源码不受影响）：

```powershell
cmd /c rmdir "<profile 目录>\node_modules\dsh-auto-context-compress"
```

## 怎么使用

### 1. 重启后确认它活着

DSH 的 bundle 层只在启动时装载，**不重启不会生效**。两处可直接确认：

**启动日志**（进程 stdout）应有：

```
[auto-context-compress] ready: platform=web soft=0.5 hard=0.75 confirm=true escalate=false
```

桌面端的这一行是 `platform=desktop`（由 `profileContext.name` 得出）。

**读接口**（Web 默认端口，loopback-only）：

```
http://127.0.0.1:3080/api/auto-context-compress
```

桌面端不使用固定端口（系统分配），不要照抄 3080；直接看右上角读数窗，或从返回值里的
`capabilities.platform` 确认读到的是 `desktop`。

返回你**每个**对话的容量占用。第一件要看的是 `capabilities`：

| 字段 | 含义 |
|---|---|
| `platform` | `desktop` / `web` / 其他 profile 名；只是宿主标签，不改变行为 |
| `meter` | 为 `false` 时不能测量压力 → 压缩完全不会发生 |
| `candidateDiscovery` | 为 `false` 时不能枚举可裁剪的工具输出 |
| `capacityProjection` | 为 `false` 时读不到窗口容量 → 退回绝对 token 兜底 |
| `sessionRegistry` | 为 `false` 时不能按 id 找到活会话 → 只能等 `pre-step` |
| `confirmation` | 为 `false` 时没有提问通道 → **永远不会裁剪**（fail-closed，不是 bug） |
| `presetServices` | 为 `false` 时穿不透预设 `isolate` 域 → 拿不到裁剪/压缩服务 |
| `route` | 为 `false` 时没有 web carrier，读接口与浮动窗口不可用（压缩仍可运行） |

这一块的意义就是把「插件没跑起来」和「插件在跑但缺某个能力」区分开。

### 2. 日常：什么都不用做

自动的那一层不需要你操作。压力越过**路由模型窗口的 50%**（`softRatio`）时，在你下一次模型请求**之前**会弹一张确认卡：

```
检测到上下文压力，是否裁剪这 3 条工具输出（省略约 47.2k 字符）？

当前请求压力约 150.0k tokens（占窗口 75%）。

可裁剪 3 条超长工具输出：文本合计 61.4k → 14.2k 字符，省略 47.2k 字符。

裁剪只改写下一次请求实际看到的模型上下文：中间段被换成省略标记，开头与结尾保留。
原始事件完整保留在会话日志中（append-only），不会丢失，可回放查看。

1. seq 412 · 工具 read · callId call-abc · 18.2k → 5.1k 字符（-13.1k）
   预览：保留开头 220 字 / 〔中间 13.1k 字符将被替换为省略标记〕/ 保留结尾 120 字
```

三个选项：

| 选项 | 效果 |
|---|---|
| **确认裁剪** | 立刻裁剪；原文仍在会话日志里 |
| **跳过本次** | 本次不裁剪，**同一回合不再追问**；下一回合压力达标时再问 |
| **关闭自动压缩** | 本次不裁剪，并全局停用，直到进程重启 |

**同一回合只问一次**，不会每一步都弹。等待有上限（`confirmTimeoutMs`，默认 120s），超时按「不裁剪」处理，不会挂住你的对话。

### 3. 按对话查看容量

```bash
# 所有对话（Web 默认端口；桌面端换成实际分配端口，或直接看读数窗）
curl "http://127.0.0.1:3080/api/auto-context-compress"
# 某一个对话（用返回里的 sessionId）
curl "http://127.0.0.1:3080/api/auto-context-compress?session=<sessionId>"
```

单个对话的读数：

```json
{
  "sessionId": "...", "title": "...", "exists": true, "live": true,
  "capacity": {
    "usedTokens": 100000, "pressureTokens": 90000, "projectedTokens": 100000,
    "contextWindow": 200000, "ratio": 0.5, "level": "soft",
    "breakdown": { "systemTokens": 5000, "toolsTokens": 20000, "messageTokens": 75000 }
  },
  "prunedResults": 3, "reclaimedTokens": 41200,
  "lastDetail": "裁剪 3 条工具输出，省略 14.9k 字符，回收约 30.0k tokens"
}
```

`level` 由本行阈值算出：`ok` / `soft` / `hard` / `unknown`（无窗口容量时）。
`breakdown` 说明窗口被什么占着——判断该不该收工具输出就看它。

### 4. 只对某个对话手动触发

```bash
curl "http://127.0.0.1:3080/api/auto-context-compress?session=<sessionId>&force=prune"
```

预约的是**那一个**对话：不泄漏到别处，也不要求它是「当前」对话。动作在该对话**下一次模型请求前**执行，并同样走确认卡（除非设了 `confirm: false`）。返回里 `armed: true` 表示已预约。

### 5. 调参

改 `<profile 目录>/node_modules/dsh-auto-context-compress/cordis.patch.yml`
（Web 默认 `~/.dsh/profiles/web`，桌面端是 `~/.dsh/profiles/desktop`；经由 Junction 就是你的插件目录），
然后重启：

| 键 | 默认 | 用途 |
|---|---|---|
| `softRatio` | `0.5` | 想更早／更晚开始询问，调这个 |
| `confirm` | `true` | **设 `false` 退回静默裁剪**——正是本插件要取代的行为，慎用 |
| `confirmTimeoutMs` | `120000` | 嫌卡片等太久就调小 |
| `enabled` | `true` | `false` 等于整个关掉 |
| `escalate` | `false` | 设 `true` 让本插件也在 75% 驱动摘要；默认交给内置 `compaction-basic` 在 80% 做 |
| `visible` | `true` | 浮动窗口是否显示（留空或 `false` 则不挂任何 DOM） |
| `pollMs` | `2000` | 浮动窗口的轮询间隔，最小 300 |
| `position` | `top-right` | 浮动窗口初始位置：`top-right` / `top-center` / `bottom-right` |

未知键会在装载时报错，不会被静默忽略——故意的，免得拼错的键悄悄不生效。
（后三个是浏览器半专用的键；host 半也会收到同一份配置，所以它同样接受这三个名字但不使用它们。）

## 显示窗口

DSH 的 Web 客户端（浏览器或桌面端渲染器）里会挂一个跟随**当前对话**的浮动读数窗（右上角），内容与读接口一致：

```
上下文压缩                                    ×
████████████░░░░░░░░░░░░░
demo 对话
占用 45.9%   458.7k / 1M
级别 ok
系统 4.5k · 工具 10.4k · 消息 405k
已裁剪 3 条 · 回收 41.2k
上次 裁剪 3 条工具输出
[ 立即压缩 ]  [ 自动：开 ]
```

- **跟随切换对话**：DSH 0.2 把「主视图正在看哪个会话」发布为 `ctx.get("uiSession").current`（绑定的 `key` 就是会话 id），本窗口订阅它，所以你切换对话框时读数立刻跟着换——**不需要重开面板，也不需要刷新页面**。若 `uiSession` 尚未装载，它退回读 shipped UI 同源的 `sessions.list` 保留计数（`byId[id].retainedBy.mainView`）；0.1 快照里的 `current` 字段也仍可读。数据源始终是那条按 id 寻址的 host 路由。
- **桌面端同一套界面**：Electron 里跑的就是这份 Web 客户端，页面来自 `dsh-app://app/`，`api/...` 请求由外壳桥接回 loopback host，所以读数窗与按钮在桌面端行为一致。Windows 下窗口会读取外壳发布的 `--dsh-windows-titlebar-height` 自动避开原生标题栏，全屏时恢复原位。
- **颜色即级别**：小圆点与进度条按 `ok` / `soft` / `hard` 变色，和本行阈值同源。
- **`立即压缩`**：对该对话预约一次裁剪（`?session=<id>&force=prune`）。真正动手仍在你下一次模型请求前，并且**仍会先弹确认卡**。
- **`自动：开/关`**：全局总开关（`?enabled=0|1`），与确认卡里的「关闭自动压缩」是同一个开关。
- **拖动 / 收起**：按住标题栏可拖动，松手记住位置，双击标题栏复位；点 `×` 收起成 `⚡ 压缩` 小圆点（**只是收起，不关功能**），点小圆点再展开。位置与收起状态存在 `localStorage`。
- **卸载即干净**：整个窗口在一个 `ctx.effect` 里创建，插件停止时 DOM 节点、事件监听、定时器与样式表一并移除。

实现上刻意**不用 React、也不注册 slot**——照 `dsh-token-usage-hud` 的做法直接用原生 DOM 挂到 `document.body`，并只写 `textContent`（不用 `innerHTML`，避免会话标题里的字符被当标记解析）。代价是它不参与产品布局；好处是插件的装卸完全不碰界面结构，也不会覆盖任何 slot 座位。

## DSH 0.2.1 适配清单

这个版本（0.3.0）针对 0.2.1 的宿主契约改了几处；每一条都保留了旧字段的读取回退，
所以即使某个宿主还带着旧形状，候选与读数也不会被直接清空。安装闸门只放行 0.2.1 线：

| 0.2.x 的变化 | 本插件的处理 |
|---|---|
| 版本兼容性改读**顶层** `engines.dsh`；`dsh.engines` 不再是权威位置 | `package.json` 顶层声明 `"dsh": ">=0.2.1-rc.2 <0.3.0-0"`，并补 `dsh.manifestVersion: 1` |
| `tool/result` 消息不再有扁平的 `callId` / `name`，改为 `source.callId` 与 `toolCallId` | 读取 `source.callId` → `toolCallId` → 旧 `callId`；工具名从结果引用的 `tool/call` 事件（`sourceEventSeqs`）经 `sessionQuery.readEvent` 取回，旧 `message.name` 仍可用 |
| 客户端会话列表快照不再有 `current`；主视图会话移到 `uiSession` 注册表 | 优先 `uiSession.current` 的绑定 `key`，退回 `byId[id].retainedBy.mainView`，最后才读 0.1 的 `current` |
| Web 支持 `--public-url` 路径前缀；桌面端用 `dsh-app://app/` 自定义协议 | 浮动窗口改用相对路径 `api/auto-context-compress`；桌面外壳会把同源请求转发到 loopback host |
| Cordis 的 `timer.timeout()` 在 fiber 释放时会 reject | 把 reject 与超时同视为「不裁剪」（fail-closed），不会出现未处理的 Promise 拒绝 |
| Web `/api` 增加了浏览器会话 cookie 与 Remote 访问策略 | 本插件是注册在 `webServer` 上的**精确**路由，先于 `/api` 前缀网关匹配；仍只接受 loopback，并保留跨站 / 伪造 Host / Origin 围栏 |
| 桌面端与 Web 共用 `dsh-web-app`，但端口由系统分配 | 不在桌面端假设 3080；读接口通过页面自身 origin 访问，`capabilities.platform` 报告 `desktop` |

## 已知边界

- **`minimal` 预设不挂任何压缩服务**（其注释写明 "Context compaction is absent"）。
  在那个预设的会话里本插件不会工作，也不会假装工作。
- **子 agent 没有人类应答者。** `userQuestions.ask` 对「被别的 agent 拥有的子 agent」会直接
  抛错（`DELEGATED_CALLER`），本插件捕获后跳过，不会把子 agent 卡死。
- **裁剪会使 KV 缓存从第一个被改动的 token 起失效**。这是所有上下文改写的固有代价；
  把它提前到 50% 的好处是这一次失效发生在压力还宽裕的时候。
- **远程 / 局域网访问时读接口不可用**：路由是 loopback-only（与 HUD 同一道围栏）。通过
  `--host 0.0.0.0` 或其他机器访问 Web 时，浮动窗口会显示「压缩服务不可用」，但压缩本身
  仍在该 host 进程里照常工作。桌面端与 `127.0.0.1` 的 Web 不受影响。
- **同机反向代理是一个例外**：如果代理自己从 loopback 连到 host，这条路由看到的来源仍是
  本机，围栏无法区分它背后的远端用户。把本插件部署在带不可信远端的反向代理后面时，请额外
  在代理层限制 `/api/auto-context-compress`，或只在本机使用。
- **`capabilities.platform` 只是标签**：Web 与桌面端共用同一套 `dsh-web-app` 组合，插件
  不按平台分支；真正的传输差异（`dsh-app://app/`）由桌面外壳处理。
- 裁剪是**语法性**的：保留开头与结尾，不判断中间哪些行在语义上更重要。这是
  `toolResultPruner` 的既有语义，本插件不改变它。

## 测试

```sh
node test/smoke.mjs          # host 半：21 条决策路径
node test/client-check.mjs   # 浏览器半：在 vm + 替身 DOM 下驱动 8 组场景
```

用一个假 host context 覆盖 21 条路径：确认、拒绝、同回合不重复询问、超时 fail-closed、
Cordis timer 释放时的 reject 仍 fail-closed、无提问通道、预设无 pruner、`confirm:false`
显式跳过询问、低于阈值不动手，跨对话部分——挂载时播种全部已存在会话、不带 id 列出全部对话、
带 id 精确寻址、两个对话各自拿到**自己的**候选内容、预约动作只作用于被指定的对话且跨对话存活，
容量检测——每条读数取 `projectedTokens` 优先、`level` 按本行阈值分类、`breakdown` 完整透出、
冷会话返回 `capacity: null` 而非编造、缺少投影服务时优雅退化为兜底预算，
0.2.1 消息形状——`source.callId` + 从 `tool/call` 事件补工具名、旧 `callId`/`name` 仍可读、
无 `turn` 时按 step 回退仍能跨回合再问、`capabilities.platform` 报告 desktop，
以及两项加固——路由围栏分别拒绝跨站请求、伪造 `Host`、`Origin` 不匹配；
重复挂载是 no-op（不产生第二条 `pre-step` 监听，因此不会弹出第二张确认卡）。

浏览器半由 `node test/client-check.mjs` 单独验证：在 `vm` 里按 `__ModuleLoader__` 契约求值，
配替身 DOM 与替身 `fetch` **真正驱动完整流程**——渲染一份读数、通过 `uiSession.current`
切换当前对话并断言它去轮询新对话、点两个按钮并断言发出的动词、最后 dispose 并断言
DOM 节点/样式表/两个订阅全部被清掉；另外覆盖没有 `uiSession` 时的
`retainedBy.mainView` 回退、晚到的 `uiSession` 被采纳、以及 0.1 的 `current` 兼容路径。
（只用 `deepStrictEqual` 比较跨 realm 数组会误报，测试里用 `Array.from` 转换。）

## 依赖

零运行时依赖：两个半都不 `import` 任何东西。

host 半的**硬注入是 `webServer` 与 `sessions`**（与 `dsh-token-usage-hud` 一致），因为两者都在 `apply` 执行的那一刻就要用：

> 这里踩过坑。我一度把 `inject` 清空以求「绝不失败激活」，结果这一行在 web carrier 注册之前就激活了，
> `ctx.get('webServer')` 返回 `undefined`，读接口被静默跳过——症状是 `/api/auto-context-compress` 恒 404，
> 而 `dsh --dump-config` 显示该行已正确合成。**`apply` 里要用的服务必须写进 `inject`。**

其余能力都按可选读取（`tokenMeter`、`timer`、`sessionQuery`、`sessionProjections`、`llm`、
`userQuestions`、`agentPresets`）——它们在激活之后才被使用，等它们没有意义，而少了一个只会降级、不会影响装载。

代价说清楚：**在没有 web carrier 的 profile 里这一行不会激活，而「已启用但未激活」是启动级失败。**
本 bundle 面向 Web profile 与桌面端（两者都带 `dsh-web-app` 的 web carrier）；headless profile 不要列它。

## 许可

MIT
