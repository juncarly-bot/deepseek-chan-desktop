"""Numeric-only, local Qwen PCM benchmark. Does not save text or audio.

Run only while DeepSeek-chan is idle: the local service has one synthesis worker.
"""
import argparse
import http.client
import json
import statistics
import time
from urllib.parse import urlparse

SAMPLE_RATE = 24000
BYTES_PER_SAMPLE = 2
TEXTS = {
    "short": "はい、わかったよ。今日は一緒に楽しくお話ししようね。",
    "medium": "そうだね、まずは大事なところから順番に見ていこう。難しく考えすぎなくて大丈夫だよ。わたしがゆっくり説明するね。",
    "long": "今日は音声の仕組みを一緒に整理してみよう。文章を短く区切ると返事は早く始められるけれど、区切りが細かすぎると声の抑揚が途切れやすくなるんだ。だから句読点を目安に文をまとめて、次の文の音声を準備している間も、今の音声を順番どおりに再生するのが大切だよ。さらに、古い返事を新しい入力で止めるときは、再生中の音声だけでなく合成待ちの音声も同じ世代番号で無効にするの。そうすれば遅れて届いた音が割り込まず、会話の流れが保ちやすくなるよ。",
    "ten_sentences": "会話の音声が途切れる原因を一つずつ見ていこう。まず、音声が作られる速さと再生される速さを比べるの。次に、短い文へ分ける位置が自然か確認するよ。句点で区切れば、抑揚を保ちやすいんだ。Qwenが次の音を作っている間も、前の音を再生できると待ち時間が減るよ。だけど合成が再生より遅いままだと、長い会話では音声が足りなくなってしまうの。バッファを増やすと最初は少し待つけれど、生成速度そのものは変わらないよ。新しい質問が来たら、古い音声をきちんと止める必要もあるね。声の雰囲気を守りながら、処理を速くできる方法を探そう。測った結果を比べて、無理のない設定に決めるわ。",
}


def p95(values):
    if not values:
        return 0.0
    return sorted(values)[max(0, int(0.95 * (len(values) - 1)))]


def run_once(host, port, path, label, text, run):
    body = json.dumps({"text": text, "purpose": "speech"}, ensure_ascii=False).encode("utf-8")
    connection = http.client.HTTPConnection(host, port, timeout=240)
    started = time.perf_counter()
    connection.request("POST", path, body, {"Content-Type": "application/json"})
    response = connection.getresponse()
    if response.status != 200:
        connection.close()
        raise RuntimeError(f"local Qwen returned HTTP {response.status}; stopping to avoid contention")

    first_pcm_ms = None
    buffer_250_ms = None
    last_ms = None
    gaps = []
    pcm_bytes = 0
    while True:
        chunk = response.read1(65536)
        if not chunk:
            break
        now_ms = (time.perf_counter() - started) * 1000
        if first_pcm_ms is None:
            first_pcm_ms = now_ms
        if buffer_250_ms is None and pcm_bytes + len(chunk) >= SAMPLE_RATE * BYTES_PER_SAMPLE // 4:
            buffer_250_ms = now_ms
        if last_ms is not None:
            gaps.append(now_ms - last_ms)
        last_ms = now_ms
        pcm_bytes += len(chunk)
    elapsed = time.perf_counter() - started
    connection.close()
    audio_seconds = pcm_bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    print(json.dumps({
        "case": label,
        "run": run,
        "chars": len(text),
        "firstPcmMs": round(first_pcm_ms or 0, 1),
        "first250msBufferMs": round(buffer_250_ms or elapsed * 1000, 1),
        "generationMs": round(elapsed * 1000, 1),
        "audioSeconds": round(audio_seconds, 2),
        "audioPerGeneration": round(audio_seconds / elapsed, 3) if elapsed else 0,
        "chunkGapMedianMs": round(statistics.median(gaps), 1) if gaps else 0,
        "chunkGapP95Ms": round(p95(gaps), 1),
        "chunkGapMaxMs": round(max(gaps), 1) if gaps else 0,
        "pcmBytes": pcm_bytes,
    }, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:18765")
    parser.add_argument("--runs", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.runs <= 5:
        parser.error("--runs must be from 1 to 5")
    parsed = urlparse(args.url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
        parser.error("only a local HTTP Qwen service is allowed")
    host = parsed.hostname
    port = parsed.port or 80
    path = parsed.path.rstrip("/") + "/stream"
    if path != "/stream":
        parser.error("the local service base URL must not include a path")
    for label, text in TEXTS.items():
        for run in range(1, args.runs + 1):
            run_once(host, port, path, label, text, run)


if __name__ == "__main__":
    main()
