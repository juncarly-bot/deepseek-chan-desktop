@echo off
chcp 65001 >nul
title Qwen3-TTS サーバー (DeepSeekちゃん用)
cd /d %~dp0
echo Qwen3-TTS ローカルサーバーを起動します（初回はモデルのダウンロードが走ります）
echo 必要: python -m pip install qwen-tts soundfile torch
python qwen-tts-server.py
pause
