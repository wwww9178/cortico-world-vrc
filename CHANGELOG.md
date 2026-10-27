# 变更记录

## 0.3.0 — 2026-10-27

### 新增
- **语音常驻 worker**（`say.py --serve`）：Piper 模型只加载一次，首句 1~3 秒、之后每句 200~400ms。
  进程崩了自动重开，`voiceWorker: false` 可退回一次性 spawn。
- **肥鱼 HTTP TTS**：`voiceProvider: feiyu` 真的能用了。POST `{text, style}` → `audio/wav` → `say.py --play-wav`。
- **OSCQuery 自动发现**：启动时读 `?HOST_INFO` 的 `OSC_PORT`，读不到回退配置；失败不影响启动。
- **房间开放度**：从日志 `Joining wrld_...~private(...)` 解析 public / friends / friends+ / invite / group；
  `erpRequirePrivate: true` 时公开房间拒绝开 ERP。
- **ERP 状态落盘**（`erpStateFile`）：重启后接着演；落盘时已超时的自动算 idle。
- **ERP 空闲收尾**（`erpIdleTimeoutSec`，默认 900s）：到点自己结束并关掉化身参数。
- **`voiceMix: voicemeeter`**：把她的声音播到 VoiceMeeter 输入，和真麦混一路。
- `erpPromptFile`：演出规则外置到任意路径，优先于包内文件。

### 变更
- `ERP_PROMPT.md` 移出仓库（gitignore），仓库只留 `examples/ERP_PROMPT.template.md`；
  运行时按 `erpPromptFile` → 包内 → 模板 的顺序找。

### 测试
- 12 例新增：日志解析 4、OSCQuery 2、配置归一化 2、提示词文件 1、混音 1、状态落盘 2、空闲收尾 2。总计 42 例。

## 0.2.0 — 2026-10-27

### 新增
- **ERP（成人向角色扮演）**：`vrc_erp` 工具，七个动作（start / stop / stage / next / say / act / status），
  阶段 `0 预热 → 1 调情 → 2 前戏 → 3 深入 → 4 余韵`。
- ERP 三路出口：chatbox 文字、语音（`whisper` 气声 / `moan` 喘息）、化身参数（按阶段切 `erpParamMap`）。
- `ERP_PROMPT.md`：演出规则外置，改完重载前缀即生效，不用重启；按 mtime 缓存。
- `tools/apply-break.mjs`：把 ERP 块写进 `CONSTITUTION.md`（带标记、可回滚）并热重载前缀。
- `voice/say.py`：`--whisper`、`--breath`、`--breath-ms`。

### 修复
- **ERP 台词双发**：`applyEmit` 直发一次 chatbox，语音条目又在队列里被 `pump()` 发一次，同一句在游戏里出现两遍。现在语音条目标记 `chatbox: false`。
- **ERP 长台词不分条**：超过 144 字会被 VRChat 截断；现在和 `vrc_say` 一样按标点分条。
- **语音被聊天框限速拖着走**：纯语音条目前不再等 `chatboxIntervalMs`，出声延迟从 ~1.6s 降到即时。
- **npm 包缺提示词文件**：`files` 里没有 `ENV_PROMPT.md` / `ERP_PROMPT.md`，发布出去后环境段是空的。

### 测试
- 新增 World 层单测（`test/world.test.mjs`）：用 `transport` 注入口断言真实发出去的 OSC，
  覆盖「一句只进 chatbox 一次」「长台词分条且不超 144 字」「erpChatbox 关掉一条都不进」等 7 例。
- 总计 30 例。

## 0.1.0 — 2026-10-26

- 首个版本：OSC chatbox + 虚拟声卡语音 + 事件回读 + 读 VRChat 日志拿世界名。
