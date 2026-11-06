// SPDX-License-Identifier: AGPL-3.0-or-later
// Screenshot module: Ctrl+Shift+X captures the screen and copies a PNG to the
// clipboard. Ctrl+X is deliberately left alone (it is Cut).
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-screenshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const SHORTCUT = Object.freeze({ key: 'x', ctrl: true, shift: true, alt: false, meta: false })

    function matchesCaptureShortcut(event) {
      return Boolean(event)
        && String(event.key || '').toLowerCase() === SHORTCUT.key
        && event.ctrlKey === SHORTCUT.ctrl
        && event.shiftKey === SHORTCUT.shift
        && Boolean(event.altKey) === SHORTCUT.alt
        && Boolean(event.metaKey) === SHORTCUT.meta
    }

    /** 输入框/可编辑区域内 Ctrl+X 仍是剪切；区域外才当截图。 */
    function isEditableTarget(target) {
      try {
        return Boolean(target?.closest?.('textarea, input, [contenteditable="true"], [contenteditable=""], [role="textbox"]'))
      } catch { return false }
    }

    function matchesPlainCtrlX(event) {
      return Boolean(event)
        && String(event.key || '').toLowerCase() === 'x'
        && event.ctrlKey === true
        && event.shiftKey === false
        && event.altKey === false
        && event.metaKey === false
    }

    function notify(text) {
      try { window.dispatchEvent(new CustomEvent('fang:notice', { detail: text })) } catch { /* ignore */ }
    }

    function canvasPng(video) {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    }

    async function captureWeb() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        notify('截图失败：当前浏览器不支持屏幕捕获')
        return false
      }
      let stream = null
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        const track = stream.getVideoTracks()[0]
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        await new Promise((resolve) => {
          if (video.videoWidth) return resolve()
          video.onloadedmetadata = resolve
        })
        const blob = await canvasPng(video)
        if (!blob) throw new Error('empty-capture')
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          notify('已截图并复制到剪贴板，可直接 Ctrl+V 粘贴')
        } catch {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `wengcheng-${Date.now()}.png`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          notify('剪贴板不可用，已下载截图 PNG')
        }
        return true
      } catch (error) {
        notify('截图已取消或失败：' + String(error?.message ?? error))
        return false
      } finally {
        for (const track of stream?.getTracks?.() ?? []) {
          try { track.stop() } catch { /* ignore */ }
        }
      }
    }

    async function capture() {
      // Electron shell: native desktopCapturer + clipboard, no browser prompt.
      if (typeof window.fangShell?.captureScreen === 'function') {
        try {
          const result = await window.fangShell.captureScreen()
          notify(result?.ok ? '已截图并复制到剪贴板，可直接 Ctrl+V 粘贴' : '截图失败：未获取到屏幕图像')
          return Boolean(result?.ok)
        } catch (error) {
          notify('截图失败：' + String(error?.message ?? error))
          return false
        }
      }
      return captureWeb()
    }

    function ScreenshotButton() {
      return h('button', {
        type: 'button',
        'data-fang-entry': 'screenshot',
        title: '截图并复制到剪贴板 (Ctrl+X 非输入框 / Ctrl+Shift+X 任意位置)',
        onClick: () => void capture(),
        style: {
          height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer',
          border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', fontSize: 12,
        },
      }, '截图 Ctrl+X / ⌘⇧X')
    }

    function onKeyDown(event) {
      const captureShortcut = matchesCaptureShortcut(event)
        || (matchesPlainCtrlX(event) && !isEditableTarget(event.target))
      if (!captureShortcut) return
      event.preventDefault()
      event.stopPropagation()
      void capture()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        document.addEventListener('keydown', onKeyDown, true)
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-screenshot',
          order: 91,
        }, ScreenshotButton))
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      },
    }
  },
})
