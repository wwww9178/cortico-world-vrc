# 变更记录

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
