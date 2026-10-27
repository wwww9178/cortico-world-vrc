# cortico-world-vrc · 规划稿 v2（含 TTS / STT / 开源到 npm）

> 目标：Coopanion 桌宠进 VRChat——**说话有字（chatbox）+ 说话有声（虚拟麦）+ 听得见（STT）+ 化身有表情（OSC 参数）**，
> 最终以 MIT 开源发布到 npm。

---

## 〇、竞品调研（2026-10 实测）

| 仓库 | 星 | 语言/许可 | 结论 |
|---|---|---|---|
| VRCWizard/TTS-Voice-Wizard | 814 | C# / MIT | 全套能力齐（STT→TTS→OSC→虚拟麦）。**只作参考**：它是独立大应用，不是 Coopanion 世界 |
| AqualCross/cortico-world-tts | 0 | JS | 同生态 TTS 世界（SpeechSynthesizer / OpenAI 兼容）。**引擎抽象可以借** |
| misyaguziya/VRCT | 456 | — / — | 聊天框翻译+转写，桌面向，集成成本高 |
| naeruru/mimiuchi | 63 | TS / GPL-3.0 | OSC 转写界面。**GPL，只读不抄** |
| gamio-22/vrchat-ai-agent | 15 | — / 无 | AI agent 全栈（STT+LLM+TTS+OSC+VRM），思路可参考 |
| npm vrchat-osc-manager / vrchat | — | JS | OSC 客户端 / VRChat API SDK，可用但 OSC 自写更稳（dgram 几十行） |

**npm 上不存在 `cortico-world-vrc`** —— 这个位置是空的。

## 一、本机已有资源（决定技术选型）

| 能力 | 现状 | 决定 |
|---|---|---|
| STT | 桌宠自带 `asr.engine=funasr`（热键左 Alt×2） | **复用**，不另起 STT |
| TTS | 她的音节语音包 `zh.ogg` + `zh.json`（407 音节） | **复用**，保持角色音色一致 |
| 音频路由 | `虚拟扬声器 (VB-Audio Cable A)` ↔ `虚拟麦克风 (VB-Audio Cable A)` | **成品配对**，直接对 VRChat 麦克风 |
| 混音（可选） | VoiceMeeter 已装 | 想「你的麦 + 她的声」同进 VRChat 时用它 |
| OSC | 无 | 自写（dgram + 手写 OSC 编码，零依赖） |

## 二、四条链路

```text
① 说话有字  她输出文字 → OSC /chatbox/input → VRChat 游戏内聊天框（144 字符上限）
② 说话有声  她输出文字 → 中文→拼音→音节序列 → zh.ogg 拼接 → 播放到「虚拟扬声器 Cable A」
                        → VRChat 麦克风选「虚拟麦克风 Cable A」→ 别人真能听见她
③ 听得见    VRChat 语音 → （Cable A 的录音端 / 或你的麦）→ funasr → 文本进她上下文
④ 有表情    她的情绪/说话状态 → OSC /avatar/parameters/* → 化身参数
```

②③ 走同一对虚拟声卡，注意**别自己咬自己**：她的 TTS 播到 Cable A 的播放端，STT 不能听 Cable A 的录音端（会听见自己）。
做法：STT 只听你的真实麦克风；VRChat 的语音由 Cable A 更上游拿（或干脆不 STT 别人，只 STT 你）。

## 三、OSC 报文

| 方向 | 地址 | 参数 | 用途 |
|---|---|---|---|
| →9000 | `/chatbox/input` | `s text` `b immediate` `b sound` | 文字进游戏 |
| →9000 | `/chatbox/typing` | `b typing` | 正在输入 |
| →9000 | `/avatar/parameters/<Name>` | `b/i/f` | 表情动作 |
| ←9001 | `/avatar/change` | `s avatarId` | 换模型 |
| ←9001 | `/avatar/parameters/*` | 视类型 | 手势/表情回读 |

## 四、配置（worlds.vrc.*）

网络：`host` `outPort(9000)` `inPort(9001)`
文字：`chatboxEnabled` `chatboxLimit(144)` `chatboxIntervalMs(1600)` `notifySound`
声音：`voiceEnabled` `voiceDevice(虚拟扬声器 (VB-Audio Cable A))` `voiceGain(1.0)` `voiceRate(1.0)` `maxChunkChars(60)`
表情：`paramEnabled` `paramMap{speaking,happy,eating,thinking → 参数名+类型}`
收敛：`enabled`

## 五、工具（6 个，克制）

| 工具 | 作用 |
|---|---|
| `vrc_status` | 在线？OSC 通？当前化身？音频设备在不在？ |
| `vrc_say` | 说一句：**同时**送 chatbox 与语音（自动分条、限速排队） |
| `vrc_voice` | 只出声不出字（小声嘀咕用） |
| `vrc_text` | 只出字不出声 |
| `vrc_param` | 设化身参数 |
| `vrc_typing` | 正在输入 |

## 六、技术选型（三处待定，但我有倾向）

1. **OSC**：自写 `dgram`（零依赖，~80 行含类型标签编码）。不引 npm 老包。
2. **TTS 合成**：复用语音包拼音节（`zh.json` 的 offset/dur）+ 8 段音高曲线。
   - 已在视频流水线验证过（`F:\Deepseek\video-studio\tools\tts-coo.mjs`），直接搬。
3. **播放到指定设备**（唯一需新写的底层）：
   - 首选 **Python + sounddevice**（可按设备名选输出，pip 装一次）
   - 备选 C# + NAudio（再编译一个 exe）
   - 不选「切换系统默认播放设备」那种 hack

## 七、里程碑（实测状态）

| | 内容 | 验收 |
|---|---|---|
| M1 | 包骨架 + 配置组 + `vrc_status` | ✅ 完成：世界 active，离线报 offline 不抛错 |
| M2 | OSC 编码 + chatbox + 限速 + 分条 | ✅ 完成：**真实 VRChat 画面里出现聊天框文字** |
| M3 | 语音：文字→Piper→播到指定设备 | ✅ 链路完成（piper 合成 2.25s，播到 Cable A）；肥鱼后端待接 |
| M4 | 参数 + 事件回读 | 回读已通（`/avatar/change` 进上下文）；参数驱动默认关闭（不夺舍你的化身） |
| M5 | 开源：README / LICENSE / 示例 / git | 进行中：文档与 MIT 已就绪，待推 GitHub 与 npm |
| M6 | ERP（成人向角色扮演） | ✅ 状态机 + 三路出口 + 阶段参数 + 单测；`tools/apply-break.mjs` 负责把全局前缀改动热重载 |
| M7 | 0.3.0：工程收尾 | ✅ 常驻语音 worker、肥鱼后端、OSCQuery 发现、房间开放度、ERP 落盘与空闲收尾、voicemeeter 混音；42 例单测 |

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| chatbox 144 字符 + 速率限制 | 按字符分条，间隔 1.6s 排队，超限不丢只延后 |
| TTS 延迟（拼接+播放） | 先 chatbox 后语音：文字即刻出，声音 0.5-1.5s 后到 |
| 自己听自己（回环） | STT 只听真实麦克风；TTS 只进 Cable A 播放端 |
| VRChat 不在前台/未开 OSC | 全部降级为「offline」，不抛错 |
| 音色不像她 | 复用同一语音包，音高参数与桌面一致（360Hz/8ups 那套） |
| 开源后被滥用 | MIT + README 明确「这是给个人桌宠用的桥接，不代运营账号」 |

## 九、发布信息（预留）

```text
包名     cortico-world-vrc
许可     MIT
要求     Node 22+ / Coopanion 0.2.8+ / VRChat 开 OSC / 一对虚拟声卡（VB-Cable 即可）
标签     vrchat, osc, chatbox, tts, tts-voice, cortico, coopanion, desktop-pet
```
