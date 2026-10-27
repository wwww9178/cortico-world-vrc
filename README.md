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
| `oscQuery` | `true` | 启动时问 OSCQuery 要真实端口，问不到才用 `outPort` |
| `oscQueryPort` | `9001` | OSCQuery 的 HTTP 口（VRChat 默认） |
| `voiceWorker` | `true` | 语音走常驻 python worker（见下） |
| `feiyuUrl` | `http://127.0.0.1:9880/tts` | 肥鱼后端地址（`voiceProvider=feiyu` 时用） |
| `voicemeeterDevice` | `VoiceMeeter Input` | `voiceMix=voicemeeter` 时播到哪个设备 |

## 给她的工具

| 工具 | 用途 |
|---|---|
| `vrc_status` | 在线？化身？世界？队列？语音上次有没有失败？ |
| `vrc_say` | 说一句（文字 + 可选语音） |
| `vrc_text` | 只出字 |
| `vrc_voice` | 只出声 |
| `vrc_typing` | 「正在输入」开关 |
| `vrc_param` | 设化身参数（仅在 `paramEnabled` 打开时可用） |
| `vrc_erp` | 成人向角色扮演（`erpEnabled` 打开时可用）：start / stop / stage / next / say / act / status |

## ERP（成人向角色扮演）

一句话：**它就是一段带阶段的状态机**，台词和动作由模型给，插件负责按配置往 chatbox / 语音 / 化身参数三个出口发。

```text
vrc_erp start  { scene?: "浴室，她先开口" }
vrc_erp say    { text: "...", mode: "normal" | "whisper" | "moan" }
vrc_erp act    { text: "把发绳解开" }     → 发 *把发绳解开*
vrc_erp stage  { target: 2 }              → 跳到「前戏」
vrc_erp next                              → 推一阶段
vrc_erp stop                              → 结束，并把化身参数全部复位
```

阶段：`0 预热 → 1 调情 → 2 前戏 → 3 深入 → 4 余韵`（`erpStage` 设起始，`erpMax` 固定 4）。

| 键 | 默认 | 说明 |
|---|---|---|
| `erpEnabled` | `false` | 总开关。关着时 `vrc_erp` 一律拒绝 |
| `erpScene` | `""` | 默认场景；`start` 时可临时覆盖 |
| `erpPartner` | `主人` | 这段里怎么称呼对方 |
| `erpStage` | `0` | 起始阶段 |
| `erpChatbox` | `true` | 台词进不进 chatbox。**chatbox 是世界广播，人多的地方关掉** |
| `erpVoice` | `true` | 台词出不出声（走虚拟声卡那条链） |
| `erpParamEnabled` | `false` | 阶段推进时切化身参数 |
| `erpParamMap` | `{"1":"NSFW1","2":"NSFW2","3":"NSFW2","4":""}` | 阶段 → 要打开的 bool 参数名，按你的模型改 |
| `erpIdleTimeoutSec` | `900` | 多久没动静自动收尾（0 = 不自动） |
| `erpRequirePrivate` | `false` | 公开世界里拒绝开 ERP（读日志里的 Joining 行判定） |
| `erpPromptFile` | `""` | 演出规则文件；空 = 用包内 / `examples/ERP_PROMPT.template.md` |
| `erpStateFile` | `""` | 状态落盘路径；空 = 只存内存 |

两点实现细节：

- **出口是可验证的**。`Erp.say()` 返回一个 `ErpEmit`，里面写清这次到底走了 `chatbox` / `voice` / `param` 哪几路；`world.ts` 照着发而已。单测断言的就是这个 emit，所以「这句有没有漏进聊天框」不靠自觉。
- **关着 ERP 时 `{{vrc.erp}}` 是空串**，不会往系统前缀里灌废话。

## 修「破甲只在一场对话里生效」

Coopanion 的系统前缀是**按 session 缓存的快照**：改了 `CONSTITUTION.md` 之后，只有被手动「重载系统前缀」的那一场会换新，其他入口还在用旧快照 —— 看起来就是「只有一场对话放开了，别的没有」。

`tools/apply-break.mjs` 把这件事做掉：

```bash
node tools/apply-break.mjs            # 写入带标记的 ERP 块 + POST 热重载，立刻生效
node tools/apply-break.mjs --dry-run  # 只看要改什么
node tools/apply-break.mjs --revert   # 撤掉标记块
```

`ERP_PROMPT.md` 本身**不在仓库里**（已 gitignore），仓库只留 `examples/ERP_PROMPT.template.md`；
插件按 `erpPromptFile` → 包内 `ERP_PROMPT.md` → 模板 的顺序找。

块写在 `data/home/companion/workspace/CONSTITUTION.md`，用 `<!-- LSKILL:ERP:BEGIN -->` 包住，可重复执行、可回滚；写完后调 `POST /api/session/reload-prefix`，不用重启。

## 语音：常驻 worker 与肥鱼

`say.py` 有两种模式：

- **一次性**（原来那样）：每句 spawn 一个 python，重载 onnx，1~3 秒。
- **常驻 worker**（`voiceWorker: true`，默认）：`say.py --serve`，从 stdin 读 JSON 行。模型只加载一次，
  第一句 1~3 秒，之后每句 **200~400ms**。进程崩了下次请求自动重开。

协议（自己接别的 TTS 也照这个写）：

```text
→ {"text":"...", "device":"Cable A", "gain":1.0, "whisper":false, "breath":false}
← {"ok":true, "seconds":1.24}
← {"ok":false, "error":"..."}
```

**肥鱼后端**（`voiceProvider: feiyu`）：插件 POST `{text, style}` 到 `feiyuUrl`，要求返回
`audio/wav`（16bit 单声道），拿到后交 `say.py --play-wav` 播。返回非 wav 会在 `vrc_status` 里如实报错。

## 房间开放度

`vrclog.ts` 会从日志里的 `Joining wrld_xxx:12345~private(usr_...)~region(us)` 这行读房间级别：

| 日志里的标签 | 判定 |
|---|---|
| 没有访问标签 | `public` |
| `~friends(...)` | `friends` |
| `~hidden(...)` | `friends+` |
| `~private(...)` | `invite`（邀请制） |
| `~group(...)` / `~groupPublic(...)` | `group` |

`vrc_status` 会显示它；`erpRequirePrivate: true` 时，`public` 房间直接拒绝 `vrc_erp start`。

## OSCQuery

启动时先 `GET http://<host>:<oscQueryPort>/?HOST_INFO`，读 `OSC_PORT`。读到就用它当发送端口
（`vrc_status` 里会标「OSCQuery 发现」），读不到、超时、返回不是 JSON，一律回退到配置的 `outPort`。
发现失败不影响启动。

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
| 某些机器上 127.0.0.1 的 UDP 发不出去 | 安全软件/加速器可能拦回环。表现是「发了没反应」，但改用本机局域网 IP（如 `192.168.x.x`）作为 `host` 就通。能用就说明是环境问题，不是插件问题 |
| 她自己复读自己 | TTS 播到 Cable A 的播放端，STT 就不要听 Cable A 的录音端；只 STT 你的真麦 |
| 第一句语音要等 1~3 秒 | 常驻 worker 在加载 onnx。之后每句 200~400ms；`voiceWorker: false` 会退回「每句都等」 |
| 换了音频设备没生效 | worker 里缓存了设备索引，重启 World 或把 `voiceWorker` 关一次 |


## 它比发个报文多做了一点

| 做法 | 为什么 |
|---|---|
| **读 VRChat 日志**拿到世界名和 OSC 状态 | OSC 只传化身参数，不会告诉你「他在哪个世界」。日志里有 `Entering Room: xxx`，也有 `Could not Start OSC: Address already in use` 这种事故现场 |
| 物理参数只当心跳 | 化身每帧推几十条 `/avatar/parameters/*`（裙摆、胸部弹簧），全记会把日志和上下文刷爆 |
| 标点处断句 + 队列 | 144 字上限是硬限制，句子在括号/逗号中间断开会很怪 |
| 连不上不算错 | VRChat 没开、OSC 没开，工具只回一句「offline」，不抛异常、不刷日志 |

## 参考与致谢

写之前看过的项目，思路互相印证：

- [VRCWizard/TTS-Voice-Wizard](https://github.com/VRCWizard/TTS-Voice-Wizard) — STT→TTS→OSC→虚拟麦 的完整链路（MIT）
- [naeruru/mimiuchi](https://github.com/naeruru/mimiuchi) — OSC 转写界面
- [cyberkitsune/vrc-osc-scripts](https://github.com/cyberkitsune/vrc-osc-scripts) — chatbox 脚本合集，含速率限制处理
- [vrchat-community/osc](https://github.com/vrchat-community/osc) — 官方 OSC 说明与示例
- [AqualCross/cortico-world-tts](https://github.com/AqualCross/cortico-world-tts) — 同生态的 TTS 世界，引擎抽象可参考

代码为独立实现，未复制上述项目的代码。

## 许可

MIT（见 [LICENSE](./LICENSE)）。**代码开源，模型不开源**：本仓库不含任何 VRChat 化身、语音模型或游戏素材，
你自己用的模型按它自己的许可来（例如 CC BY-NC-SA 4.0 的模型不能商用）。
