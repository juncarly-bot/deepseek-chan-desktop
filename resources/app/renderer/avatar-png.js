'use strict'
/**
 * avatar-png.js — PNG アバター表示＋口パク
 *
 * イラストを Canvas に描き、発話音声の音量レベル（0〜1）に合わせて
 * 口の位置に楕円を開く。口位置は設定 (avatar.mouthX / mouthY, 0〜1) で調整可能。
 * 画像が読めない場合は <img> フォールバック表示に切り替える。
 */
;(function () {
  class PngAvatar {
    constructor(canvas, imgEl) {
      this.canvas = canvas
      this.ctx = canvas.getContext('2d')
      this.imgEl = imgEl
      this.img = new Image()
      this.level = 0
      this.targetLevel = 0
      this.mouthX = 0.5
      this.mouthY = 0.66
      this.emotion = 'neutral'
      this.raf = null
      this.bobPhase = 0
    }

    async load(src) {
      await new Promise((resolve, reject) => {
        this.img.onload = resolve
        this.img.onerror = reject
        this.img.src = src
      })
      this.canvas.style.display = 'block'
      this.imgEl.style.display = 'none'
      this.start()
    }

    showFallback(src) {
      this.canvas.style.display = 'none'
      this.imgEl.src = src
      this.imgEl.style.display = 'block'
    }

    setMouth(level) {
      this.targetLevel = Math.max(0, Math.min(1, level))
    }

    setEmotion(name) {
      this.emotion = name
    }

    setMouthPosition(x, y) {
      if (typeof x === 'number') this.mouthX = x
      if (typeof y === 'number') this.mouthY = y
    }

    start() {
      if (this.raf) return
      const draw = () => {
        this.raf = requestAnimationFrame(draw)
        this.level += (this.targetLevel - this.level) * 0.45
        if (this.targetLevel === 0 && this.level < 0.01) this.level = 0
        const { ctx, canvas, img } = this
        if (!img.naturalWidth) return
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        // 発話中はほんの少し上下に揺れる
        this.bobPhase += this.level > 0.03 ? 0.25 : 0.03
        const bob = Math.sin(this.bobPhase) * (this.level > 0.03 ? 3 : 1)
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)
        const w = img.naturalWidth * scale
        const h = img.naturalHeight * scale
        const x = (canvas.width - w) / 2
        const y = (canvas.height - h) / 2 + bob
        ctx.drawImage(img, x, y, w, h)
        // 口パク: 音量に応じて楕円が開く
        if (this.level > 0.02) {
          const mx = x + w * this.mouthX
          const my = y + h * this.mouthY
          const mh = 2 + this.level * h * 0.045
          const mw = w * 0.035 * (0.7 + this.level * 0.5)
          ctx.beginPath()
          ctx.ellipse(mx, my, mw, mh, 0, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(120,30,40,0.85)'
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = 'rgba(200,110,120,0.9)'
          ctx.stroke()
        }
      }
      draw()
    }

    dispose() {
      if (this.raf) cancelAnimationFrame(this.raf)
      this.raf = null
      this.canvas.style.display = 'none'
    }
  }

  window.PngAvatar = PngAvatar
})()
