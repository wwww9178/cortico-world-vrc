"""把一句话合成为语音，并播到指定的音频设备（默认 VB-Audio Cable A）。

为什么是 Python：Node 侧没有可靠的「按设备名选输出」能力，sounddevice（PortAudio）
可以直接按名字挑设备，这对「把声音送进虚拟声卡 → VRChat 麦克风」是必需的。

三种用法：

1. 一次性（调试用；每次都要重载 onnx，1~3 秒）：
       python say.py --text "鲸鱼娘来啦" --device "Cable A"
       python say.py --list-devices
       python say.py --text "..." --whisper --breath --gain 0.8

2. 常驻 worker（插件默认走这条，模型只加载一次，之后每句 200~400ms）：
       python say.py --serve
   stdin 每行一个 JSON：{"text": "...", "device": "...", "gain": 1.0, "whisper": false, "breath": false}
   stdout 每行一个 JSON：{"ok": true, "seconds": 1.24} 或 {"ok": false, "error": "..."}

3. 只播现成的 wav（肥鱼那种 HTTP TTS 回来的音频）：
       python say.py --play-wav out.wav --device "Cable A" --gain 1.0
"""
from __future__ import annotations

import argparse
import json
import sys
import wave
from pathlib import Path

DEFAULT_MODEL = Path(r"F:/Deepseek/video-studio/episodes/ep01/assets/tts/zh_CN-huayan-medium.onnx")
DEFAULT_BREATH_MS = 280
WHISPER_RATE = 1.22
WHISPER_GAIN = 0.55

_voice_cache: dict[str, object] = {}
_device_cache: dict[str, int] = {}


def list_devices() -> None:
    import sounddevice as sd

    print("可用的输出设备：")
    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"] > 0:
            api = sd.query_hostapis(d["hostapi"])["name"]
            print(f"  {i:>3}  {d['name']}  ({api}, {d['max_output_channels']}ch)")
    default = sd.query_devices(kind="output")
    print(f"\n默认输出：{default['name']}")


def pick_device(substr: str) -> int:
    """按名字里的一段找输出设备；同一段名字只查一次。"""
    if substr in _device_cache:
        return _device_cache[substr]
    import sounddevice as sd

    hits = []
    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"] <= 0:
            continue
        if substr.lower() in d["name"].lower():
            hits.append((i, d))
    if not hits:
        raise SystemExit(f"找不到名字里含「{substr}」的输出设备（用 --list-devices 看全量）")
    # 优先 WASAPI / DirectSound 这类现代驱动，MME 音质差；这里取第一个匹配即可
    _device_cache[substr] = hits[0][0]
    return hits[0][0]


def load_voice(model: Path):
    key = str(model)
    if key in _voice_cache:
        return _voice_cache[key]
    from piper import PiperVoice

    if not model.exists():
        raise SystemExit(f"piper 模型不存在：{model}")
    voice = PiperVoice.load(str(model))
    _voice_cache[key] = voice
    return voice


def synth_piper(text: str, model: Path, length_scale: float) -> tuple[bytes, int]:
    from piper.config import SynthesisConfig

    voice = load_voice(model)
    cfg = SynthesisConfig(length_scale=length_scale)
    pcm = b"".join(chunk.audio_int16_bytes for chunk in voice.synthesize(text, syn_config=cfg))
    return pcm, voice.config.sample_rate


def add_breath(pcm: bytes, rate: int, breath_ms: int) -> bytes:
    """句首空一段，听感上像先喘一口气再开口。"""
    pad = int(rate * breath_ms / 1000)
    return b"\x00\x00" * pad + pcm


def play_pcm(pcm: bytes, rate: int, device: int, gain: float) -> None:
    import numpy as np
    import sounddevice as sd

    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if gain != 1.0:
        samples = np.clip(samples * gain, -1.0, 1.0)
    sd.play(samples, rate, device=device, blocking=True)


def wav_to_pcm(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("只支持 16bit 单声道 wav")
        return w.readframes(w.getnframes()), w.getframerate()


def speak_once(req: dict) -> dict:
    """合成 + 播放一句话。serve 模式和一次性模式共用。"""
    text = str(req.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "text 为空"}
    device_name = str(req.get("device") or "Cable A")
    gain = float(req.get("gain") or 1.0)
    whisper = bool(req.get("whisper"))
    breath = bool(req.get("breath"))
    model = Path(str(req.get("model") or DEFAULT_MODEL))

    length_scale = float(req.get("length_scale") or 1.05)
    if whisper:
        length_scale *= WHISPER_RATE
        gain *= WHISPER_GAIN

    pcm, rate = synth_piper(text, model, length_scale)
    if breath:
        pcm = add_breath(pcm, rate, int(req.get("breath_ms") or DEFAULT_BREATH_MS))
    device = pick_device(device_name)
    play_pcm(pcm, rate, device, gain)
    return {"ok": True, "seconds": round(len(pcm) / 2 / rate, 3)}


def serve() -> int:
    """常驻：模型和设备的查找结果都留在进程里。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"坏 JSON: {e}"}), flush=True)
            continue
        try:
            result = speak_once(req)
        except SystemExit as e:
            result = {"ok": False, "error": str(e)}
        except Exception as e:  # noqa: BLE001
            result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--device", default="Cable A", help="输出设备名里的一段（默认 Cable A）")
    ap.add_argument("--engine", default="piper", choices=["piper"])
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--length-scale", type=float, default=1.05)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--whisper", action="store_true", help="气声：降增益、拖慢语速")
    ap.add_argument("--breath", action="store_true", help="句首加一段喘息停顿")
    ap.add_argument("--breath-ms", type=int, default=DEFAULT_BREATH_MS)
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--serve", action="store_true", help="常驻 worker，从 stdin 读 JSON 行")
    ap.add_argument("--play-wav", help="只播一个现成的 16bit 单声道 wav，不合成")
    ap.add_argument("--wav-out", help="只合成不播，把 wav 写到这个路径")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return 0

    if args.serve:
        return serve()

    if args.play_wav:
        pcm, rate = wav_to_pcm(Path(args.play_wav))
        device = pick_device(args.device)
        play_pcm(pcm, rate, device, args.gain)
        print(f"已播放 {len(pcm)/2/rate:.2f}s → 设备 #{device}")
        return 0

    if not args.text:
        print("没有 --text", file=sys.stderr)
        return 2

    length_scale = args.length_scale
    gain = args.gain
    if args.whisper:
        length_scale *= WHISPER_RATE
        gain *= WHISPER_GAIN

    pcm, rate = synth_piper(args.text, Path(args.model), length_scale)

    if args.breath:
        pcm = add_breath(pcm, rate, args.breath_ms)

    if args.wav_out:
        with wave.open(args.wav_out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm)
        print(f"已写 {args.wav_out}  ({len(pcm)/2/rate:.2f}s)")
        return 0

    device = pick_device(args.device)
    play_pcm(pcm, rate, device, gain)
    print(f"已播放 {len(pcm)/2/rate:.2f}s → 设备 #{device}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
