"""Loopback-only Qwen service. One inference at a time; no conversation logs."""
import io
import json
import os
import threading
import time
import argparse
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('HF_HOME', str(ROOT / 'qwen-runtime' / 'hf-cache'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
MODEL = ROOT / 'qwen-runtime' / 'model'
PORT = int(os.environ.get('QWEN_TTS_PORT', '8765'))
state = {'ok': False, 'service': 'deepseek-qwen-local-v1', 'device': 'cpu', 'status': 'loading', 'model': 'Qwen3-TTS-12Hz-0.6B-CustomVoice'}
model = None
lock = threading.Lock()
cache = OrderedDict()
SPEAKERS = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee']

def load():
    global model
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        torch.set_num_threads(int(os.environ.get('QWEN_CPU_THREADS', '4')))
        torch.set_num_interop_threads(1)
        model = Qwen3TTSModel.from_pretrained(str(MODEL), device_map='cpu', dtype=torch.float32, attn_implementation='sdpa', local_files_only=True)
        state.update(ok=True, status='ready')
        print('Qwen model ready (CPU, 4 threads)', flush=True)
    except Exception as exc:
        state.update(status='error', error=type(exc).__name__)
        import traceback
        traceback.print_exc()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, content_type='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        if self.path == '/health':
            self.reply(200 if state['ok'] else 503, state)
        elif self.path == '/speakers':
            self.reply(200, [{'id': s, 'label': s} for s in SPEAKERS])
        else:
            self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/synthesize':
            return self.reply(404, {'error': 'not found'})
        if not state['ok']:
            return self.reply(503, {'error': '音声モデルを準備しています。少し待って再試行してください。'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                return self.reply(400, {'error': 'invalid request size'})
            data = json.loads(self.rfile.read(length))
            text = str(data.get('text', '')).strip()
            speaker = data.get('speaker', 'Vivian')
            language = data.get('language', 'Japanese')
            speed = float(data.get('speed', 1.0))
            pitch = float(data.get('pitch', 0.0))
            if not text or len(text) > 300 or speaker not in SPEAKERS or language not in ['Japanese', 'Auto']:
                return self.reply(400, {'error': 'invalid text, speaker or language'})
            if not 0.8 <= speed <= 1.2 or not -2 <= pitch <= 2:
                return self.reply(400, {'error': 'invalid speed or pitch'})
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'invalid JSON or values'})
        if not lock.acquire(blocking=False):
            return self.reply(429, {'error': '音声を生成中です。再生が終わってから試してください。'})
        try:
            import torch
            import soundfile as sf
            key = (text, speaker, language, speed, pitch)
            started = time.monotonic()
            if key in cache:
                audio = cache[key]
                cache.move_to_end(key)
            else:
                with torch.inference_mode():
                    torch.manual_seed(42)
                    # Limit runaway generation for short sentences. Sampling is
                    # the model's default and generally preserves natural prosody.
                    limit = min(240, max(96, len(text) * 4 + 24))
                    wavs, sr = model.generate_custom_voice(text=text, speaker=speaker, language=language, max_new_tokens=limit)
                wav = wavs[0]
                if speed != 1 or pitch != 0:
                    import librosa
                    if pitch != 0:
                        wav = librosa.effects.pitch_shift(wav, sr=sr, n_steps=pitch)
                    if speed != 1:
                        wav = librosa.effects.time_stretch(wav, rate=speed)
                buf = io.BytesIO()
                sf.write(buf, wav, sr, format='WAV', subtype='PCM_16')
                audio = buf.getvalue()
                cache[key] = audio
                while len(cache) > 12:
                    cache.popitem(last=False)
            print(f'synthesis complete: {time.monotonic()-started:.1f}s, {len(audio)} bytes', flush=True)
            self.reply(200, audio, 'audio/wav')
        except Exception as exc:
            print(f'synthesis failed: {type(exc).__name__}', flush=True)
            self.reply(500, {'error': '音声生成に失敗しました。Qwenのログを確認してください。'})
        finally:
            lock.release()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--owner-pid', type=int)
    args = parser.parse_args()
    if args.owner_pid and os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        parent = kernel.OpenProcess(0x00100000, False, args.owner_pid)
        if not parent:
            raise RuntimeError('Unable to watch application process')
        def watch_parent():
            kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
            kernel.CloseHandle(parent)
            os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=load, daemon=True).start()
    print(f'Qwen service listening on 127.0.0.1:{PORT}', flush=True)
    server.serve_forever()
