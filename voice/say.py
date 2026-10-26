"""把一句话合成为语音，并播到指定的音频设备（默认 VB-Audio Cable A）。

为什么是 Python：Node 侧没有可靠的「按设备名选输出」能力，sounddevice（PortAudio）
可以直接按名字挑设备，这对「把声音送进虚拟声卡 → VRChat 麦克风」是必需的。

用法：
    python say.py --text "鲸鱼娘来啦" --device "Cable A"
    python say.py --list-devices
    python say.py --text "..." --engine piper --length-scale 1.1 --gain 0.8
"""
from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path

DEFAULT_MODEL = Path(r"F:/Deepseek/video-studio/episodes/ep01/assets/tts/zh_CN-huayan-medium.onnx")


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
    return hits[0][0]


def synth_piper(text: str, model: Path, length_scale: float) -> tuple[bytes, int]:
    from piper import PiperVoice
    from piper.config import SynthesisConfig

    if not model.exists():
        raise SystemExit(f"piper 模型不存在：{model}")
    voice = PiperVoice.load(str(model))
    cfg = SynthesisConfig(length_scale=length_scale)
    pcm = b"".join(chunk.audio_int16_bytes for chunk in voice.synthesize(text, syn_config=cfg))
    return pcm, voice.config.sample_rate


def play(pcm: bytes, rate: int, device: int, gain: float) -> None:
    import numpy as np
    import sounddevice as sd

    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if gain != 1.0:
        samples = np.clip(samples * gain, -1.0, 1.0)
    sd.play(samples, rate, device=device, blocking=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--device", default="Cable A", help="输出设备名里的一段（默认 Cable A）")
    ap.add_argument("--engine", default="piper", choices=["piper"])
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--length-scale", type=float, default=1.05)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--wav-out", help="只合成不播，把 wav 写到这个路径")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return 0
    if not args.text:
        print("没有 --text", file=sys.stderr)
        return 2

    pcm, rate = synth_piper(args.text, Path(args.model), args.length_scale)

    if args.wav_out:
        with wave.open(args.wav_out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm)
        print(f"已写 {args.wav_out}  ({len(pcm)/2/rate:.2f}s)")
        return 0

    device = pick_device(args.device)
    play(pcm, rate, device, args.gain)
    print(f"已播放 {len(pcm)/2/rate:.2f}s → 设备 #{device}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
