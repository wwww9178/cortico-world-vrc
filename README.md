# cortico-world-vrc

让 **Coopanion 桌宠**在 **VRChat** 里说话：文字进游戏聊天框（chatbox），声音经虚拟声卡进游戏麦克风。
走 VRChat **官方 OSC 接口**，不注入客户端、不改游戏文件。

> 状态：M1–M3 已实测通过（chatbox 真的出现在游戏画面里、语音真的播进 VB-Audio Cable A）；M4/M5 见 [PLAN.md](./PLAN.md)。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 说话有字 | 文字 → `/chatbox/input` → 游戏内聊天框（上限 144 字符，超长自动分条、按间隔排队） |
| 说话有声 | 文字 → TTS → 播到指定音频设备（如 VB-Audio Cable A）→ VRChat 麦克风选中它 → 别人真能听见 |
| 听得见 | VRChat 往 `/avatar/change`、`/world/change` 等发事件 → 变成她的上下文 |
| 有表情（可选，默认关） | `/avatar/parameters/*` 驱动**你自己的**化身。默认关闭，因为这会「夺舍」你的化身 |

## 不做什么

- 不送音频流（VRChat 语音是音频通道，OSC 做不到，所以走虚拟声卡）
- 不碰别人的化身、不自动进世界、不加好友
- 不附带任何模型/语音/素材（只开源实现）

---

## 前置：VRChat 侧

1. 启动 VRChat，进任意世界
2. 打开 **Action Menu**（桌面按 `R`）
3. 进 **Options** → 找到 **OSC** → 切成 **Enabled**
4. 日志里应出现 `Advertising Service ... type OSC on 9000`；如果出现 `Could not Start OSC: Address already in use`，说明 9000 被别的程序占了（常见就是本插件装了两个实例），关掉占用者再切一次

端口约定（VRChat 自己定的，别搞反）：

```
VRChat 监听 9000  ← 我们往这里发（chatbox / 参数）
VRChat 发往 9001  → 我们在这里听（事件 / 物理参数刷屏）
```

## 前置：声音（可选）

```
她的 TTS ──播放到──▶ 虚拟扬声器 (VB-Audio Cable A)
                              │  （驱动内部直通）
VRChat 麦克风 ──选择──▶ 虚拟麦克风 (VB-Audio Cable A)
```

装 [VB-Audio Cable](https://vb-audio.com/Cable/) 即可得到这一对设备。
若想让「你的真麦 + 她的声音」混在一起送进 VRChat，用 VoiceMeeter 把两者并到一路，再把 VRChat 麦克风指向 `Voicemeeter Out B1`。

## 前置：TTS

当前实现两种后端：

| `voiceProvider` | 说明 |
|---|---|
| `off` | 不出声（默认） |
| `piper` | 本机 [Piper](https://github.com/rhasspy/piper)，需 `pip install piper-tts sounddevice numpy` 和一个中文 `.onnx` 音色 |
| `feiyu` | 肥鱼声音服务（HTTP，声线更自然）。**代码位已留，尚未接入实现** |

`piper` 需要改 `voice/say.py` 里的 `DEFAULT_MODEL` 指向你的音色文件，或在配置里不管、直接改脚本。
可以先只验合成：

```bash
python voice/say.py --text "鲸鱼娘来啦" --wav-out out.wav
python voice/say.py --list-devices      # 看设备名，配置里的 voiceDevice 要能匹配到
```

## 安装

```bash
# 假设 Coopanion 装在 C:\Users\you\Coopanion
cd C:\Users\you\Coopanion\data\extensions
node ..\..\resources\app\node_modules\pnpm\bin\pnpm.cjs \
  add "link:C:/path/to/cortico-world-vrc"
```

然后在 Coopanion 的世界列表里启用 **VRChat**，重启应用。

## 配置（`worlds.vrc.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | OSC 目标地址。VRChat 在另一台机器/串流时改这里 |
| `outPort` | `9000` | 发给 VRChat 的端口（它监听这个） |
| `inPort` | `9001` | 接 VRChat 事件的端口（0=不听） |
| `chatboxEnabled` | `true` | 是否送字进聊天框 |
| `chatboxLimit` | `144` | 单条字数上限 |
| `chatboxIntervalMs` | `1600` | 两条之间最小间隔（VRChat 有速率限制） |
| `notifySound` | `false` | chatbox 是否播提示音 |
| `typingIndicator` | `true` | 是否允许「正在输入」 |
| `voiceEnabled` | `false` | 是否出声 |
| `voiceProvider` | `off` | `off` / `piper` / `feiyu` |
| `voiceDevice` | `虚拟扬声器 (VB-Audio Cable A)` | 音频设备名里的一段 |
| `voiceGain` | `1` | 音量倍率 |
| `voiceMix` | `solo` | `solo` 只有她；`voicemeeter` 预留 |
| `paramEnabled` | `false` | 是否允许驱动你自己的化身参数 |
| `activeWithinSec` | `120` | 多久没有 OSC 就算离线 |

## 给她的工具

| 工具 | 用途 |
|---|---|
| `vrc_status` | 在线？化身？世界？队列？语音上次有没有失败？ |
| `vrc_say` | 说一句（文字 + 可选语音） |
| `vrc_text` | 只出字 |
| `vrc_voice` | 只出声 |
| `vrc_typing` | 「正在输入」开关 |
| `vrc_param` | 设化身参数（仅在 `paramEnabled` 打开时可用） |

## 调试

```bash
# 监听 VRChat 发来的事件（默认过滤物理参数刷屏，加 --all 看全量）
node --experimental-strip-types tools/vrc-cli.mjs listen

# 直接发一条到聊天框
node --experimental-strip-types tools/vrc-cli.mjs send "鲸鱼娘来啦" 9000
```

## 已知坑

| 现象 | 原因与处理 |
|---|---|
| 游戏里没字 | 十有八九 OSC 没起来。看 VRChat 日志 `%LOCALAPPDATA%Low\VRChat\VRChat\output_log_*.txt` 搜 `OSC`，出现 `Address already in use` 就是端口被占 |
| 发出去没反应 | 端口反了。记住：**往 9000 发，在 9001 听** |
| 日志被刷爆 | `/avatar/parameters/*` 是化身物理参数（裙摆/胸部弹簧），每秒几十条。本插件只当心跳用，不记录内容 |
| 听不见她 | `voiceDevice` 名字要能匹配到设备；VRChat 麦克风要选 **虚拟麦克风 (VB-Audio Cable A)**，不是扬声器 |
| 她自己复读自己 | TTS 播到 Cable A 的播放端，STT 就不要听 Cable A 的录音端；只 STT 你的真麦 |

## 许可

MIT（见 [LICENSE](./LICENSE)）。**代码开源，模型不开源**：本仓库不含任何 VRChat 化身、语音模型或游戏素材，
你自己用的模型按它自己的许可来（例如 CC BY-NC-SA 4.0 的模型不能商用）。
