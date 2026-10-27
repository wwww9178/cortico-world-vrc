import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { ERP_DEFAULTS, ERP_MAX_STAGE, ERP_STAGES, normalizeErpConfig, type ErpConfig } from './erp.ts';

export interface VrcConfig {
  host: string;
  outPort: number;
  inPort: number;
  chatboxEnabled: boolean;
  chatboxLimit: number;
  chatboxIntervalMs: number;
  notifySound: boolean;
  typingIndicator: boolean;
  voiceEnabled: boolean;
  voiceProvider: 'off' | 'piper' | 'feiyu';
  voiceStyle: string;
  voiceDevice: string;
  voiceGain: number;
  voiceMix: 'solo' | 'voicemeeter';
  paramEnabled: boolean;
  activeWithinSec: number;
  /** 成人向角色扮演。字段细节见 erp.ts。 */
  erp: ErpConfig;
  /** 用 OSCQuery 自动发现 VRChat 的 OSC 端口，发现失败就回退到 outPort。 */
  oscQuery: boolean;
  /** OSCQuery 的 HTTP 端口（VRChat 默认 9001）。 */
  oscQueryPort: number;
  /** 语音走常驻 worker（否则每句重新 spawn 一次 python）。 */
  voiceWorker: boolean;
  /** 肥鱼 HTTP TTS 端点（voiceProvider=feiyu 时用）。 */
  feiyuUrl: string;
  /** voiceMix=voicemeeter 时播到哪个设备（VoiceMeeter 的输入）。 */
  voicemeeterDevice: string;
  /** 公开世界里拒绝开 ERP（不知道房间开放度时不受影响）。 */
  erpRequirePrivate: boolean;
  /** ERP 演出规则的正文文件；空 = 用包里/示例里的那一份。 */
  erpPromptFile: string;
  /** ERP 状态落盘路径；空 = 只存内存。 */
  erpStateFile: string;
}

export const VRC_DEFAULTS: VrcConfig = {
  host: '127.0.0.1',
  outPort: 9000,   // VRChat 在 9000 上「听」我们的指令（它自己绑定这个端口）
  inPort: 9001,    // VRChat 从 9001 往外发状态
  chatboxEnabled: true,
  chatboxLimit: 144,
  chatboxIntervalMs: 1600,
  notifySound: false,
  typingIndicator: true,
  voiceEnabled: false,
  voiceProvider: 'off',
  voiceStyle: 'cute',
  voiceDevice: '虚拟扬声器 (VB-Audio Cable A)',
  voiceGain: 1,
  voiceMix: 'solo',
  paramEnabled: false,
  activeWithinSec: 120,
  erp: { ...ERP_DEFAULTS, paramMap: { ...ERP_DEFAULTS.paramMap } },
  oscQuery: true,
  oscQueryPort: 9001,
  voiceWorker: true,
  feiyuUrl: 'http://127.0.0.1:9880/tts',
  voicemeeterDevice: 'VoiceMeeter Input',
  erpRequirePrivate: false,
  erpPromptFile: '',
  erpStateFile: '',
};

export function normalizeConfig(raw: Record<string, unknown>): VrcConfig {
  const cfg: VrcConfig = { ...VRC_DEFAULTS, erp: { ...VRC_DEFAULTS.erp, paramMap: { ...VRC_DEFAULTS.erp.paramMap } } };
  const num = (v: unknown, lo: number, hi: number, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
  };
  if (typeof raw.host === 'string' && raw.host.trim()) cfg.host = raw.host.trim();
  if (typeof raw.voiceDevice === 'string') cfg.voiceDevice = raw.voiceDevice;
  if (typeof raw.voiceStyle === 'string') cfg.voiceStyle = raw.voiceStyle;
  if (raw.voiceProvider === 'piper' || raw.voiceProvider === 'feiyu' || raw.voiceProvider === 'off') {
    cfg.voiceProvider = raw.voiceProvider;
  }
  if (raw.voiceMix === 'voicemeeter' || raw.voiceMix === 'solo') cfg.voiceMix = raw.voiceMix;
  if (typeof raw.feiyuUrl === 'string' && raw.feiyuUrl.trim()) cfg.feiyuUrl = raw.feiyuUrl.trim();
  if (typeof raw.voicemeeterDevice === 'string' && raw.voicemeeterDevice.trim()) cfg.voicemeeterDevice = raw.voicemeeterDevice.trim();
  if (typeof raw.erpPromptFile === 'string') cfg.erpPromptFile = raw.erpPromptFile.trim();
  if (typeof raw.erpStateFile === 'string') cfg.erpStateFile = raw.erpStateFile.trim();
  for (const key of [
    'chatboxEnabled', 'notifySound', 'typingIndicator', 'voiceEnabled', 'paramEnabled',
    'oscQuery', 'voiceWorker', 'erpRequirePrivate',
  ] as const) {
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key] as boolean;
  }
  cfg.outPort = Math.round(num(raw.outPort, 1, 65535, cfg.outPort));
  cfg.inPort = Math.round(num(raw.inPort, 0, 65535, cfg.inPort));
  cfg.chatboxLimit = Math.round(num(raw.chatboxLimit, 32, 144, cfg.chatboxLimit));
  cfg.chatboxIntervalMs = Math.round(num(raw.chatboxIntervalMs, 300, 10000, cfg.chatboxIntervalMs));
  cfg.voiceGain = num(raw.voiceGain, 0, 2, cfg.voiceGain);
  cfg.oscQueryPort = Math.round(num(raw.oscQueryPort, 1, 65535, cfg.oscQueryPort));
  cfg.activeWithinSec = Math.round(num(raw.activeWithinSec, 10, 3600, cfg.activeWithinSec));
  cfg.erp = normalizeErpConfig(raw);
  return cfg;
}

export function vrcConfigGroup(language: Language = 'zh'): ConfigGroup {
  const zh = language === 'zh';
  const t = (cn: string, en: string) => (zh ? cn : en);
  return {
    id: 'world:vrc',
    owner: 'world:vrc',
    schema: {
      type: 'object',
      title: t('VRChat 接入', 'VRChat bridge'),
      description: t(
        '通过 OSC 让桌宠在 VRChat 里说话（chatbox + 语音）。VRChat 要在 Action Menu → Options 里打开 OSC。',
        'Let the pet speak inside VRChat over OSC (chatbox + voice). Enable OSC in VRChat Action Menu.',
      ),
      properties: {
        'worlds.vrc.host': { type: 'string', title: t('OSC 目标地址', 'OSC host'), 'x-hot': false, default: VRC_DEFAULTS.host },
        'worlds.vrc.outPort': { type: 'integer', title: t('发送端口', 'Out port'), minimum: 1, maximum: 65535, 'x-hot': false, default: VRC_DEFAULTS.outPort },
        'worlds.vrc.inPort': { type: 'integer', title: t('接收端口（0=不听）', 'In port (0 = off)'), minimum: 0, maximum: 65535, 'x-hot': false, default: VRC_DEFAULTS.inPort },
        'worlds.vrc.chatboxEnabled': { type: 'boolean', title: t('把话送进游戏聊天框', 'Send to chatbox'), 'x-hot': true, default: true },
        'worlds.vrc.chatboxLimit': { type: 'integer', title: t('单条字数上限', 'Chatbox char limit'), minimum: 32, maximum: 144, 'x-hot': true, default: VRC_DEFAULTS.chatboxLimit },
        'worlds.vrc.chatboxIntervalMs': { type: 'integer', title: t('两条之间最小间隔（毫秒）', 'Min gap (ms)'), minimum: 300, maximum: 10000, 'x-hot': true, default: VRC_DEFAULTS.chatboxIntervalMs },
        'worlds.vrc.notifySound': { type: 'boolean', title: t('chatbox 播提示音', 'Chatbox sound'), 'x-hot': true, default: VRC_DEFAULTS.notifySound },
        'worlds.vrc.typingIndicator': { type: 'boolean', title: t('显示「正在输入」', 'Typing indicator'), 'x-hot': true, default: true },
        'worlds.vrc.voiceEnabled': { type: 'boolean', title: t('出声说话（走虚拟声卡）', 'Speak aloud (virtual cable)'), 'x-hot': true, default: false },
        'worlds.vrc.voiceProvider': {
          type: 'string', enum: ['off', 'piper', 'feiyu'], title: t('语音引擎', 'Voice engine'), 'x-hot': true, default: 'off',
          description: t('off=不出声；piper=本机 Piper（先跑通链路）；feiyu=肥鱼声音服务（好听，需另装）', 'off / piper / feiyu'),
        },
        'worlds.vrc.voiceStyle': { type: 'string', title: t('声线（fatfish 用）', 'Voice style'), 'x-hot': true, default: 'cute' },
        'worlds.vrc.voiceDevice': { type: 'string', title: t('播到哪个音频设备', 'Playback device'), 'x-hot': true, default: VRC_DEFAULTS.voiceDevice },
        'worlds.vrc.voiceGain': { type: 'number', title: t('音量', 'Gain'), minimum: 0, maximum: 2, 'x-hot': true, default: 1 },
        'worlds.vrc.voiceMix': { type: 'string', enum: ['solo', 'voicemeeter'], title: t('混音方式', 'Mix mode'), 'x-hot': true, default: 'solo' },
        'worlds.vrc.paramEnabled': { type: 'boolean', title: t('驱动化身参数（默认关闭）', 'Drive avatar params'), 'x-hot': true, default: false },
        'worlds.vrc.activeWithinSec': { type: 'integer', title: t('多久内有 OSC 动静算在线（秒）', 'Online window (s)'), minimum: 10, maximum: 3600, 'x-hot': true, default: 120 },
        'worlds.vrc.erpEnabled': {
          type: 'boolean', title: t('ERP 模式（成人向角色扮演）', 'ERP mode (adult roleplay)'), 'x-hot': true, default: ERP_DEFAULTS.enabled,
          description: t('打开后 vrc_erp 才能用。台词按 erpChatbox / erpVoice 的开关出。', 'Enables the vrc_erp tool.'),
        },
        'worlds.vrc.erpScene': {
          type: 'string', title: t('默认场景', 'Default scene'), 'x-hot': true, default: ERP_DEFAULTS.scene,
          description: t('在哪、什么气氛、谁先开口。vrc_erp start 时可以临时覆盖。', 'Where it happens; can be overridden per start.'),
        },
        'worlds.vrc.erpPartner': { type: 'string', title: t('对方称呼', 'Partner name'), 'x-hot': true, default: ERP_DEFAULTS.partner },
        'worlds.vrc.erpChatbox': {
          type: 'boolean', title: t('台词进 chatbox', 'RP lines to chatbox'), 'x-hot': true, default: ERP_DEFAULTS.chatbox,
          description: t('注意：chatbox 在世界里公开可见。人多的地方关掉它、只留语音或全静默。', 'Chatbox is public in-world.'),
        },
        'worlds.vrc.erpVoice': { type: 'boolean', title: t('台词同时出声', 'RP lines spoken'), 'x-hot': true, default: ERP_DEFAULTS.voice },
        'worlds.vrc.erpStage': {
          type: 'integer', title: t('起始阶段', 'Start stage'), minimum: 0, maximum: ERP_MAX_STAGE, 'x-hot': true, default: ERP_DEFAULTS.stage,
          description: t(`0=${ERP_STAGES[0]} … ${ERP_MAX_STAGE}=${ERP_STAGES[ERP_MAX_STAGE]}`, '0 = warm-up'),
        },
        'worlds.vrc.erpParamEnabled': { type: 'boolean', title: t('阶段切化身参数', 'Stage drives avatar params'), 'x-hot': true, default: ERP_DEFAULTS.paramEnabled },
        'worlds.vrc.erpParamMap': {
          type: 'object', title: t('阶段 → 参数名', 'Stage → param name'), 'x-hot': true, default: ERP_DEFAULTS.paramMap,
          description: t('例如 {"1":"NSFW1","2":"NSFW2"}；参数名要和你模型里的完全一致。', 'e.g. {"1":"NSFW1","2":"NSFW2"}'),
        },
        'worlds.vrc.erpIdleTimeoutSec': {
          type: 'integer', title: t('多久没动静自动收尾（秒，0=不自动）', 'Auto-end after idle (s, 0 = never)'),
          minimum: 0, maximum: 86400, 'x-hot': true, default: ERP_DEFAULTS.idleTimeoutSec,
        },
        'worlds.vrc.erpRequirePrivate': {
          type: 'boolean', title: t('公开世界拒绝开 ERP', 'Refuse ERP in public rooms'), 'x-hot': true, default: false,
          description: t('从 VRChat 日志里读到的房间级别是 public 时不开始。', 'Uses the room access line from the VRChat log.'),
        },
        'worlds.vrc.erpPromptFile': {
          type: 'string', title: t('ERP 规则文件（留空用包内那份）', 'ERP prompt file'), 'x-hot': true, default: '',
        },
        'worlds.vrc.erpStateFile': {
          type: 'string', title: t('ERP 状态落盘路径（留空=不落盘）', 'ERP state file'), 'x-hot': true, default: '',
        },
        'worlds.vrc.oscQuery': {
          type: 'boolean', title: t('OSCQuery 自动发现端口', 'OSCQuery auto-discovery'), 'x-hot': true, default: true,
        },
        'worlds.vrc.oscQueryPort': {
          type: 'integer', title: t('OSCQuery 端口', 'OSCQuery port'), minimum: 1, maximum: 65535, 'x-hot': false, default: 9001,
        },
        'worlds.vrc.voiceWorker': {
          type: 'boolean', title: t('语音常驻 worker（首句慢、之后快）', 'Keep TTS worker alive'), 'x-hot': true, default: true,
        },
        'worlds.vrc.feiyuUrl': {
          type: 'string', title: t('肥鱼 TTS 地址', 'Feiyu TTS URL'), 'x-hot': true, default: 'http://127.0.0.1:9880/tts',
        },
        'worlds.vrc.voicemeeterDevice': {
          type: 'string', title: t('VoiceMeeter 输入设备', 'VoiceMeeter input device'), 'x-hot': true, default: 'VoiceMeeter Input',
        },
      },
    },
  } as ConfigGroup;
}
