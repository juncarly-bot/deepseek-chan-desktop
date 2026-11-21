"""Local-only experimental streaming voice, using the user's saved voice A."""
import argparse
import hashlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'qwen-runtime'
VOICE = RUNTIME / 'voice-a'
MODEL = RUNTIME / 'native-model'
SERVICE = 'deepseek-voice-a-fast-v1'
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
state = {'ok': False, 'service': SERVICE, 'status': 'loading', 'voice': 'voice-a', 'sampleRate': 24000}
engine = None
lock = threading.Lock()

def filler_token_budget(text):
    return min(20, max(10, len(text) * 2 + 6))

def load_engine():
    global engine
    try:
        from RealtimeTTS import QwenCpuEngine, QwenVoice
        text = (VOICE / 'reference.txt').read_text(encoding='utf-8-sig').strip()
        ref = VOICE / 'reference.wav'
        voice = QwenVoice(name='voice-a', ref_audio=str(ref), ref_text=text, language='chinese')
        engine = QwenCpuEngine(voice=voice,
            talker_path=MODEL / 'qwen-talker-0.6b-base-Q8_0.gguf',
            codec_path=MODEL / 'qwen-tokenizer-12hz-Q8_0.gguf',
            voice_cache_dir=RUNTIME / 'native-voice-cache', local_files_only=True,
            quant='Q8_0', seed=42, max_new_tokens=128, clone_mode='auto',
            cpu_threads=4, cpu_codec_threads=6, cpu_stream_frames=2,
            startup_buffer_ms=0, warmup=True, warmup_tokens=16)
        state.update(ok=True, status='ready', referenceSha256=hashlib.sha256(ref.read_bytes()).hexdigest())
        print('Voice A ready', flush=True)
    except Exception as exc:
        import traceback
        state.update(status='error', error=type(exc).__name__)
        traceback.print_exc()

class Server(ThreadingHTTPServer):
    daemon_threads = True

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if self.headers.get('Origin'):
            self.reply(403, {'error': '直接のブラウザ接続はできません'})
            return False
        return True

    def do_GET(self):
        if not self.allowed(): return
        if self.path == '/health': return self.reply(200 if state['ok'] else 503, state)
        return self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if not self.allowed(): return
        if self.path != '/stream': return self.reply(404, {'error': 'not found'})
        try:
            if self.headers.get('Content-Type', '').split(';', 1)[0].strip() != 'application/json':
                return self.reply(415, {'error': 'JSONが必要です'})
            n = int(self.headers.get('Content-Length', '0'))
            if not 0 < n <= 8192: raise ValueError('size')
            data = json.loads(self.rfile.read(n).decode('utf-8'))
            text = data.get('text', '')
            purpose = data.get('purpose', 'speech')
            if purpose not in ('speech', 'filler'): raise ValueError('purpose')
            if not isinstance(text, str) or not text.strip() or len(text) > 300: raise ValueError('text')
        except (ValueError, UnicodeError, AttributeError):
            return self.reply(400, {'error': '読み上げ文を確認してください'})
        if not state['ok']: return self.reply(503, {'error': '音声モデルを準備しています'})
        if not lock.acquire(blocking=False): return self.reply(429, {'error': '読み上げ中です'})
        disconnected = False
        sent = 0
        original_put = engine.queue.put
        self.send_response(200)
        self.send_header('Content-Type', 'audio/pcm')
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        def output(pcm, *args, **kwargs):
            nonlocal disconnected, sent
            if disconnected: return
            block = bytes(pcm)
            if not block: return
            try:
                self.wfile.write(f'{len(block):X}\r\n'.encode('ascii') + block + b'\r\n')
                self.wfile.flush()
                sent += len(block)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                disconnected = True
                engine.stop()
        engine.queue.put = output
        try:
            if purpose == 'filler':
                # Short cached interjections should stay short; normal speech keeps its existing budget.
                max_new_tokens = filler_token_budget(text)
            else:
                max_new_tokens = min(512, max(128, len(text)*4+36))
            engine.set_voice_parameters(max_new_tokens=max_new_tokens)
            if not engine.synthesize(text.strip()):
                raise RuntimeError(type(engine.last_error).__name__)
            if not disconnected:
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
            print('sent audio bytes:', sent, flush=True)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            print('synthesis error:', type(exc).__name__, flush=True)
            self.close_connection = True
        finally:
            engine.queue.put = original_put
            lock.release()

def watch_parent(pid):
    if not pid: return
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = k.OpenProcess(0x00100000, False, pid)
    if not handle: raise RuntimeError('owner process not found')
    def wait():
        k.WaitForSingleObject(handle, 0xFFFFFFFF)
        k.CloseHandle(handle)
        os._exit(0)
    threading.Thread(target=wait, daemon=True).start()

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--owner-pid', type=int, default=0)
    p.add_argument('--port', type=int, default=18765)
    args = p.parse_args()
    watch_parent(args.owner_pid)
    server = Server(('127.0.0.1', args.port), Handler)
    threading.Thread(target=load_engine, daemon=True).start()
    print('Fast voice service listening on 127.0.0.1:', args.port, flush=True)
    server.serve_forever()
