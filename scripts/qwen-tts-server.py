#!/usr/bin/env python3
"""
qwen-tts-server.py — Qwen3-TTS ローカルサーバー（DeepSeekちゃん用）

Qwen3-TTS CustomVoice モデルを読み込み、HTTP API で音声合成を提供する。
DeepSeekちゃんアプリ側は「音声エンジン: Qwen3-TTS / 接続方式: ローカル」で
このサーバーに接続する。中国語ネイティブ話者（Vivian 等）に日本語を読ませると
中国語なまりの日本語になる（tegnike の動画と同じ方式）。

前提:
    pip install qwen-tts soundfile torch
    - NVIDIA GPU 推奨（0.6B で VRAM 約3〜6GB、1.7B で約4〜8GB）
    - CPU でも動くが非常に遅い。初回はモデルのダウンロード（約1.2GB〜）が走る

環境変数:
    QWEN_TTS_MODEL  既定 Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
    QWEN_TTS_PORT   既定 8765
    QWEN_TTS_HOST   既定 127.0.0.1

API:
    GET  /health     -> {"ok": true, "model": ..., "device": ...}
    GET  /speakers   -> [{"id": "Vivian", "label": "...", "native": "Chinese"}, ...]
    POST /synthesize {"text": "...", "speaker": "Vivian", "language": "Japanese", "instruct": ""}
                     -> audio/wav
"""
import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
PORT = int(os.environ.get("QWEN_TTS_PORT", "8765"))
HOST = os.environ.get("QWEN_TTS_HOST", "127.0.0.1")

SPEAKERS = [
    {"id": "Vivian", "native": "Chinese", "label": "Vivian（中国語・明るい若い女性）"},
    {"id": "Serena", "native": "Chinese", "label": "Serena（中国語・温かく柔らかい若い女性）"},
    {"id": "Uncle_Fu", "native": "Chinese", "label": "Uncle_Fu（中国語・落ち着いた男性）"},
    {"id": "Dylan", "native": "Chinese", "label": "Dylan（中国語・北京の若い男性）"},
    {"id": "Eric", "native": "Chinese", "label": "Eric（中国語・男性）"},
    {"id": "Ryan", "native": "English", "label": "Ryan（英語・男性）"},
    {"id": "Aiden", "native": "English", "label": "Aiden（英語・男性）"},
    {"id": "Ono_Anna", "native": "Japanese", "label": "Ono_Anna（日本語・元気な女性）"},
    {"id": "Sohee", "native": "Korean", "label": "Sohee（韓国語・女性）"},
]

_model = None
_device = "unknown"


def load_model():
    global _model, _device
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError:
        print("[qwen-tts-server] qwen-tts / torch が入っていません。", file=sys.stderr)
        print("  pip install qwen-tts soundfile torch", file=sys.stderr)
        sys.exit(1)
    if torch.cuda.is_available():
        _device = "cuda:0"
        dtype = torch.bfloat16
        attn = "flash_attention_2"
        try:
            _model = Qwen3TTSModel.from_pretrained(
                MODEL_ID, device_map=_device, dtype=dtype, attn_implementation=attn
            )
        except Exception:
            # FlashAttention が無い環境では SDPA にフォールバック
            _model = Qwen3TTSModel.from_pretrained(MODEL_ID, device_map=_device, dtype=dtype)
    else:
        _device = "cpu"
        print("[qwen-tts-server] 警告: GPU が無いため CPU で動かします（非常に遅くなります）", file=sys.stderr)
        _model = Qwen3TTSModel.from_pretrained(MODEL_ID, device_map="cpu", dtype=torch.float32)
    print(f"[qwen-tts-server] model loaded: {MODEL_ID} on {_device}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # アクセスログを静かにする
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": _model is not None, "model": MODEL_ID, "device": _device})
        elif self.path == "/speakers":
            self._json(200, SPEAKERS)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = str(payload.get("text", "")).strip()
            if not text:
                self._json(400, {"error": "text is empty"})
                return
            speaker = payload.get("speaker") or "Vivian"
            language = payload.get("language") or "Japanese"
            instruct = payload.get("instruct") or ""
            wavs, sr = _model.generate_custom_voice(
                text=text, language=language, speaker=speaker, instruct=instruct
            )
            import soundfile as sf

            buf = io.BytesIO()
            sf.write(buf, wavs[0], sr, format="WAV")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # モデル側の例外を 500 で返す（アプリ側はブラウザTTSに退避する）
            self._json(500, {"error": str(e)})


def main():
    load_model()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[qwen-tts-server] listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
