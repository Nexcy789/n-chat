#!/usr/bin/env python
"""把一段音频转成文字（faster-whisper，CPU int8）。

用法：
    python transcribe.py <音频文件> [模型名]

输出一行 JSON：
    {"ok": true, "text": "...", "lang": "zh", "dur": 65.2, "segments": 28}

失败：
    {"ok": false, "error": "..."}

设计上的两个要点：
1. **建议用独立 venv**，不要混进主环境 —— faster-whisper 对 av 的版本挑剔，
   主环境里已经有别的 av 版本时会 import 失败。
2. 模型缓存在 HF_HOME 里，第一次会下载（small ≈ 480MB），之后离线可用。
   HF_ENDPOINT 默认指到国内镜像，否则经常卡在连接 huggingface.co。
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 2026-11-17：Windows 上 python 的 stdout 被重定向到管道时，默认按 **cp936(GBK)** 编码输出，
# Node 那边按 UTF-8 解码 ⇒ 中文全变成「������」。必须在这里钉死成 UTF-8，
# 光靠调用方的 PYTHONIOENCODING 环境变量不够稳（从 .bat 启动的宿主进程常常没继承到）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001  老版本 Python 没有 reconfigure
    pass

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频路径"}, ensure_ascii=False))
        return

    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("ASR_MODEL", "small")

    if not os.path.exists(path):
        print(json.dumps({"ok": False, "error": "音频文件不存在: " + path}, ensure_ascii=False))
        return

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "faster_whisper 导入失败: %s" % exc}, ensure_ascii=False))
        return

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            path,
            vad_filter=True,          # 掐掉长静音，纯 BGM 的视频会得到空文本而不是一堆幻觉
            beam_size=1,              # 速度优先，内容够用
            condition_on_previous_text=False,   # 防止前一句带偏后面
        )
        rows = [s.text.strip() for s in segments if s.text.strip()]
        print(json.dumps({
            "ok": True,
            "text": "\n".join(rows),
            "lang": getattr(info, "language", ""),
            "dur": round(float(getattr(info, "duration", 0) or 0), 1),
            "segments": len(rows),
        }, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
