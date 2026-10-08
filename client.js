/**
 * Browser half of the Mermaid viewer bundle.
 *
 * One entry sits in the finalized assistant message's action row
 * (`conversation.chat.assistant-actions`) and appears only when that message
 * carries a fenced `mermaid` block. Clicking it opens a frame-wide viewer
 * (`shell.overlay`) that lazily loads the vendored mermaid chunk and renders the
 * diagrams — nothing is rendered while the reply streams, and nothing is
 * rendered until the reader asks for it.
 *
 * Each rendered diagram owns a zoom viewport — wheel or toolbar zoom, drag to
 * pan, fit to view — and can be viewed full screen on its own.
 *
 * The diagram sources arrive from the Host half's `mermaidDiagrams` session
 * projection through the session-scoped `useProjection` seat, so this module
 * never folds the session log.
 *
 * Plain browser JavaScript on purpose: it loads through the Client module table
 * (`window.__ModuleLoader__`) with React supplied by the loader, and it writes
 * its own controls and styles instead of importing another Client package.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mermaid-viewer',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React

    /** Bundle id, also stamped on the injected style tag. */
    const PLUGIN_ID = '@local/dsh-mermaid-viewer'
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-mermaid-viewer'
    /** The Host half's projection key. */
    const PROJECTION_KEY = 'mermaidDiagrams'
    /** Package-local chunk holding the vendored mermaid build. */
    const MERMAID_CHUNK = './client.mermaid.js'

    /** Smallest and largest scale a reader can reach, matching the document preview. */
    const MIN_ZOOM = 0.25
    const MAX_ZOOM = 4
    /** Scale interval used by the toolbar's incremental controls. */
    const ZOOM_STEP = 0.25
    /** Bounds one diagram's viewport height stays inside. */
    const VIEWPORT_MIN_HEIGHT = 140
    const VIEWPORT_MAX_HEIGHT = 640
    /** Share of the window height one diagram may occupy before it starts panning. */
    const VIEWPORT_HEIGHT_RATIO = 0.6
    /** Sub-pixel slack: content that fits within a pixel is not worth panning for. */
    const PAN_TOLERANCE = 1
    /** Full-screen viewing needs the element API; a nested browsing context may deny it. */
    const FULLSCREEN_SUPPORTED = typeof Element !== 'undefined'
      && typeof Element.prototype.requestFullscreen === 'function'
      && document.fullscreenEnabled !== false

    /** Simplified Chinese dictionary ({name} placeholders). */
    const zh = {
      'action.render': '渲染 Mermaid 图',
      'action.renderCount': '渲染 {count} 张 Mermaid 图',
      'viewer.title': 'Mermaid 图',
      'viewer.titleCount': 'Mermaid 图（{count}）',
      'viewer.close': '关闭',
      'viewer.loading': '正在渲染…',
      'viewer.render': '图 {index}',
      'viewer.renderFailed': '第 {index} 张图渲染失败：{message}',
      'viewer.hint': '按 Esc 关闭',
      'viewer.zoomControls': '缩放控件',
      'viewer.zoomOut': '缩小',
      'viewer.zoomIn': '放大',
      'viewer.zoomValue': '{percent}%',
      'viewer.fit': '适应窗口',
      'viewer.fullscreen': '全屏查看',
      'viewer.exitFullscreen': '退出全屏',
      'viewer.fullscreenFailed': '无法进入全屏，可继续用缩放查看',
    }

    /** English dictionary. */
    const en = {
      'action.render': 'Render Mermaid diagram',
      'action.renderCount': 'Render {count} Mermaid diagrams',
      'viewer.title': 'Mermaid diagram',
      'viewer.titleCount': 'Mermaid diagrams ({count})',
      'viewer.close': 'Close',
      'viewer.loading': 'Rendering…',
      'viewer.render': 'Diagram {index}',
      'viewer.renderFailed': 'Diagram {index} failed to render: {message}',
      'viewer.hint': 'Press Esc to close',
      'viewer.zoomControls': 'Zoom controls',
      'viewer.zoomOut': 'Zoom out',
      'viewer.zoomIn': 'Zoom in',
      'viewer.zoomValue': '{percent}%',
      'viewer.fit': 'Fit to view',
      'viewer.fullscreen': 'View full screen',
      'viewer.exitFullscreen': 'Exit full screen',
      'viewer.fullscreenFailed': 'Could not enter full screen; zooming stays available',
    }

    /**
     * Plugin-owned styles. Only `--dsw-*` aliases are read, so the viewer
     * follows the active theme (including a token-override theme) and disabling
     * the bundle removes every rule with the tag.
     */
    const CSS = `
.dshmm-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dshmm-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshmm-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshmm-action svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); }
.dshmm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vh 4vw;
  /* The overlay layer is click-through; a modal opts back in itself instead of
     relying on the layer's direct-child rule. */
  pointer-events: auto;
  background: var(--dsw-alias-bg-mask-drop, rgba(0, 0, 0, 0.45));
}
.dshmm-panel {
  display: flex;
  flex-direction: column;
  width: min(1080px, 94vw);
  max-height: 90vh;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 18px 48px var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, 0.3));
  color: var(--dsw-alias-label-primary);
}
.dshmm-panel:focus { outline: none; }
.dshmm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshmm-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; }
.dshmm-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dshmm-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 4px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dshmm-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshmm-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshmm-close svg { width: 16px; height: 16px; }
.dshmm-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: auto;
  padding: 16px;
  background: var(--dsw-alias-bg-base);
}
.dshmm-diagram {
  position: relative;
  overflow: hidden;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshmm-diagram:fullscreen {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--dsw-alias-bg-base);
}
.dshmm-diagram::backdrop { background: var(--dsw-alias-bg-base); }
/* The surface keeps the drawing's user-unit size; one transform moves it, so a
   zoom or pan gesture never re-lays out the svg. */
.dshmm-viewport { position: relative; width: 100%; overflow: hidden; }
.dshmm-surface { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.dshmm-surface svg { display: block; width: 100%; height: 100%; max-width: none !important; }
.dshmm-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-elevation-prominent, 0 4px 12px var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, 0.2)));
}
.dshmm-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 4px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dshmm-tool:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshmm-tool:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshmm-tool:disabled { opacity: 0.4; cursor: default; }
.dshmm-tool svg { width: 15px; height: 15px; }
.dshmm-zoom-value {
  min-width: 42px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.dshmm-notice {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 2;
  max-width: calc(100% - 16px);
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshmm-status { padding: 28px 16px; color: var(--dsw-alias-label-tertiary); font-size: 13px; text-align: center; }
.dshmm-failure {
  padding: 16px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}
`

    /** One process-wide mermaid load; a failed load stays retryable. */
    let mermaidLoad = null

    /**
     * Load the vendored mermaid chunk once.
     * @returns the mermaid API object.
     */
    function loadMermaid() {
      if (mermaidLoad === null) {
        mermaidLoad = require.async(MERMAID_CHUNK).catch((error) => {
          mermaidLoad = null
          throw error
        })
      }
      return mermaidLoad
    }

    /**
     * Parse a CSS color this plugin can read back from a theme token.
     * @param value - computed token value (`#rgb`, `#rrggbb`, or `rgb()`/`rgba()`).
     * @returns the channels, or null for a value it cannot read.
     */
    function parseColor(value) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
      if (hex !== null) {
        const digits = hex[1].length === 3
          ? hex[1].split('').map(char => char + char).join('')
          : hex[1]
        return [0, 2, 4].map(offset => Number.parseInt(digits.slice(offset, offset + 2), 16))
      }
      const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value)
      return rgb === null ? null : [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    }

    /**
     * Whether the active palette is dark, read from the canvas token the theme
     * layer writes; mermaid needs one of its two built-in palettes.
     * @returns true for a dark canvas.
     */
    function activeSchemeIsDark() {
      const read = element => (element === null ? '' : getComputedStyle(element).getPropertyValue('--dsw-alias-bg-base'))
      const channels = parseColor(read(document.body) || read(document.documentElement))
      if (channels === null) return window.matchMedia('(prefers-color-scheme: dark)').matches
      return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255 < 0.5
    }

    /** @param error - thrown value. @returns its message for display. */
    function describeError(error) {
      return error instanceof Error && error.message !== '' ? error.message : String(error)
    }

    /** Render counter keeping mermaid's temporary element ids unique per render. */
    let renderSeq = 0

    /** Diagram-in-a-box glyph: two nodes joined by an elbow connector. */
    function DiagramGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 1.5, y: 1.5, width: 5, height: 4, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 9.5, y: 10.5, width: 5, height: 4, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', {
          d: 'M4 5.5V9a1.5 1.5 0 0 0 1.5 1.5h4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.8 8.9 9.5 10.5 7.8 12.1',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /** Close glyph. */
    function CloseGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      )
    }

    /** @returns value clamped into [min, max]. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * The scale that shows a whole diagram without upscaling it.
     * @param width - drawing width in user units.
     * @param height - drawing height in user units.
     * @param boxWidth - viewport width in CSS pixels.
     * @param boxHeight - viewport height in CSS pixels.
     * @returns the fit scale, bounded by the zoom range.
     */
    function fitScale(width, height, boxWidth, boxHeight) {
      if (width <= 0 || height <= 0 || boxWidth <= 0 || boxHeight <= 0) return 1
      return clamp(Math.min(1, boxWidth / width, boxHeight / height), MIN_ZOOM, 1)
    }

    /**
     * Keep scaled content inside its viewport: centred while it fits, otherwise
     * bounded so no content edge travels inside the viewport edge.
     * @param offset - requested pan offset in CSS pixels.
     * @param contentSize - scaled content size in CSS pixels.
     * @param boxSize - viewport size in CSS pixels.
     * @returns the offset to render.
     */
    function clampOffset(offset, contentSize, boxSize) {
      if (contentSize <= boxSize) return (boxSize - contentSize) / 2
      return clamp(offset, boxSize - contentSize, 0)
    }

    /**
     * The next quarter-step scale above or below the current one.
     * @param scale - current scale.
     * @param direction - 1 to zoom in, -1 to zoom out.
     * @returns the stepped scale.
     */
    function steppedZoom(scale, direction) {
      const step = direction === -1 ? Math.ceil(scale / ZOOM_STEP) - 1 : Math.floor(scale / ZOOM_STEP) + 1
      return clamp(step * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM)
    }

    /**
     * Read a rendered mermaid svg's drawing box in user units, which the zoom
     * surface is sized from.
     * @param svg - the rendered svg element.
     * @returns the drawing width and height.
     */
    function intrinsicSize(svg) {
      const viewBox = svg.viewBox === undefined ? null : svg.viewBox.baseVal
      if (viewBox !== null && viewBox.width > 0 && viewBox.height > 0) {
        return { width: viewBox.width, height: viewBox.height }
      }
      let box = null
      try { box = svg.getBBox() } catch (error) {
        // A detached svg has no user-unit box; the measured rect below is the fallback.
      }
      if (box !== null && box.width > 0 && box.height > 0) return { width: box.width, height: box.height }
      const rect = svg.getBoundingClientRect()
      return { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) }
    }

    /** Minus glyph for the zoom-out control. */
    function MinusGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M3 8h10',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        }),
      )
    }

    /** Plus glyph for the zoom-in control. */
    function PlusGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M8 3v10M3 8h10',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        }),
      )
    }

    /** Fit glyph: the drawing brought back inside its frame. */
    function FitGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('rect', {
          x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('rect', {
          x: 5, y: 6, width: 6, height: 4, rx: 0.8,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        }),
      )
    }

    /** Corner-bracket glyph pointing outward: enter full screen. */
    function ExpandGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /** Corner-bracket glyph pointing inward: leave full screen. */
    function CollapseGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M2 6h4V2M14 6h-4V2M14 10h-4v4M2 10h4v4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * One toolbar control.
     * @param props - accessible label, disabled state, click handler, and glyph.
     * @returns the button.
     */
    function ToolButton(props) {
      const { label, disabled, onClick, children } = props
      return h('button', {
        type: 'button',
        className: 'dshmm-tool',
        title: label,
        'aria-label': label,
        disabled: disabled === true,
        onMouseDown: (event) => { event.preventDefault() },
        onClick,
      }, children)
    }

    /**
     * One rendered diagram with its own zoom viewport, persistent toolbar, and
     * full-screen mode.
     *
     * The viewport height follows the fit scale until it reaches the
     * window-relative cap, after which the reader pans; entering full screen
     * hands the height back to the browser. Wheel zoom needs the platform
     * modifier inside the panel, where the plain wheel still scrolls the diagram
     * list, and needs no modifier in full screen, where nothing scrolls.
     *
     * @param props - rendered svg markup, its 1-based index, and the locale seat.
     * @returns the diagram card.
     */
    function DiagramCard(props) {
      const { svg, index, t } = props
      const cardRef = useRef(null)
      const viewportRef = useRef(null)
      const surfaceRef = useRef(null)
      const dragRef = useRef(null)
      const [intrinsic, setIntrinsic] = useState(null)
      const [box, setBox] = useState({ width: 0, height: 0 })
      const [view, setView] = useState({ fit: true, scale: 1, x: 0, y: 0 })
      const [fullscreen, setFullscreen] = useState(false)
      const [notice, setNotice] = useState(null)

      useLayoutEffect(() => {
        const surface = surfaceRef.current
        const svgElement = surface === null ? null : surface.querySelector('svg')
        if (svgElement !== null) setIntrinsic(intrinsicSize(svgElement))
      }, [svg])

      useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (viewport === null) return undefined
        const measure = () => {
          const width = viewport.clientWidth
          const height = viewport.clientHeight
          setBox(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(viewport)
        return () => { observer.disconnect() }
      }, [])

      useEffect(() => {
        const onChange = () => {
          setFullscreen(document.fullscreenElement === cardRef.current)
          setNotice(null)
        }
        document.addEventListener('fullscreenchange', onChange)
        return () => {
          document.removeEventListener('fullscreenchange', onChange)
          if (document.fullscreenElement === cardRef.current) void document.exitFullscreen()
        }
      }, [])

      const heightCap = fullscreen
        ? box.height
        : Math.min(window.innerHeight * VIEWPORT_HEIGHT_RATIO, VIEWPORT_MAX_HEIGHT)
      const fit = intrinsic === null ? 1 : fitScale(intrinsic.width, intrinsic.height, box.width, heightCap)
      const scale = view.fit ? fit : view.scale
      const contentWidth = intrinsic === null ? 0 : intrinsic.width * scale
      const contentHeight = intrinsic === null ? 0 : intrinsic.height * scale
      const offsetX = clampOffset(view.x, contentWidth, box.width)
      const offsetY = clampOffset(view.y, contentHeight, box.height)
      const pannable = contentWidth > box.width + PAN_TOLERANCE || contentHeight > box.height + PAN_TOLERANCE
      const viewportHeight = fullscreen
        ? '100%'
        : `${String(intrinsic === null
          ? VIEWPORT_MIN_HEIGHT
          : clamp(intrinsic.height * fit, VIEWPORT_MIN_HEIGHT, Math.max(heightCap, VIEWPORT_MIN_HEIGHT)))}px`

      /** Values the last paint used; gesture handlers read these instead of re-subscribing. */
      const renderedRef = useRef({ scale: 1, x: 0, y: 0 })
      renderedRef.current = { scale, x: offsetX, y: offsetY }

      const zoomTo = useCallback((next, clientX, clientY) => {
        const viewport = viewportRef.current
        if (viewport === null) return
        const current = renderedRef.current
        const target = clamp(next, MIN_ZOOM, MAX_ZOOM)
        if (target === current.scale) return
        const bounds = viewport.getBoundingClientRect()
        const x = clientX === undefined ? bounds.width / 2 : clientX - bounds.left
        const y = clientY === undefined ? bounds.height / 2 : clientY - bounds.top
        const ratio = target / current.scale
        setView({ fit: false, scale: target, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio })
      }, [])

      const fitView = useCallback(() => { setView({ fit: true, scale: 1, x: 0, y: 0 }) }, [])

      useEffect(() => {
        const viewport = viewportRef.current
        if (viewport === null) return undefined
        const onWheel = (event) => {
          if (!fullscreen && !event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          // deltaMode: 1 line, 2 page, 0 pixel.
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
          const delta = clamp(event.deltaY * unit, -40, 40)
          zoomTo(renderedRef.current.scale * Math.exp(-delta * 0.01), event.clientX, event.clientY)
        }
        viewport.addEventListener('wheel', onWheel, { passive: false })
        return () => { viewport.removeEventListener('wheel', onWheel) }
      }, [fullscreen, zoomTo])

      const onPointerDown = (event) => {
        if (event.button !== 0 || !pannable) return
        event.preventDefault()
        const current = renderedRef.current
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          originX: current.x,
          originY: current.y,
          scale: current.scale,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        setView({
          fit: false,
          scale: drag.scale,
          x: drag.originX + event.clientX - drag.x,
          y: drag.originY + event.clientY - drag.y,
        })
      }

      const endDrag = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }

      const onDoubleClick = (event) => {
        if (view.fit) zoomTo(1, event.clientX, event.clientY)
        else fitView()
      }

      const toggleFullscreen = () => {
        const card = cardRef.current
        if (card === null) return
        setNotice(null)
        if (document.fullscreenElement === card) {
          void document.exitFullscreen()
          return
        }
        if (typeof card.requestFullscreen !== 'function') return
        Promise.resolve(card.requestFullscreen()).catch(() => { setNotice(t('viewer.fullscreenFailed')) })
      }

      return h('div', { ref: cardRef, className: 'dshmm-diagram' },
        h('div', { className: 'dshmm-toolbar', role: 'toolbar', 'aria-label': t('viewer.zoomControls') },
          h(ToolButton, {
            label: t('viewer.zoomOut'),
            disabled: scale <= MIN_ZOOM,
            onClick: () => { zoomTo(steppedZoom(scale, -1)) },
          }, h(MinusGlyph)),
          h('span', { className: 'dshmm-zoom-value' }, t('viewer.zoomValue', { percent: Math.round(scale * 100) })),
          h(ToolButton, {
            label: t('viewer.zoomIn'),
            disabled: scale >= MAX_ZOOM,
            onClick: () => { zoomTo(steppedZoom(scale, 1)) },
          }, h(PlusGlyph)),
          h(ToolButton, { label: t('viewer.fit'), onClick: fitView }, h(FitGlyph)),
          FULLSCREEN_SUPPORTED && h(ToolButton, {
            label: fullscreen ? t('viewer.exitFullscreen') : t('viewer.fullscreen'),
            onClick: toggleFullscreen,
          }, h(fullscreen ? CollapseGlyph : ExpandGlyph)),
        ),
        h('div', {
          ref: viewportRef,
          className: 'dshmm-viewport',
          style: {
            height: viewportHeight,
            touchAction: pannable ? 'none' : 'auto',
            userSelect: pannable ? 'none' : undefined,
            cursor: pannable ? 'grab' : undefined,
          },
          role: 'img',
          'aria-label': t('viewer.render', { index }),
          onPointerDown,
          onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onDoubleClick,
        }, h('div', {
          ref: surfaceRef,
          className: 'dshmm-surface',
          style: {
            width: `${String(intrinsic === null ? 1 : intrinsic.width)}px`,
            height: `${String(intrinsic === null ? 1 : intrinsic.height)}px`,
            transform: `translate(${String(offsetX)}px, ${String(offsetY)}px) scale(${String(scale)})`,
          },
          dangerouslySetInnerHTML: { __html: svg },
        })),
        notice !== null && h('p', { className: 'dshmm-notice', role: 'alert' }, notice),
      )
    }

    /**
     * The finalized-message action: present only while the Host projection holds
     * diagrams for this message id.
     * @param props - message identity, the session projection seat, the injected
     * opener, and the locale seat.
     * @returns the action button, or nothing for a message without diagrams.
     */
    function MermaidAction(props) {
      const { messageId, useProjection, open, t } = props
      const sources = useProjection(PROJECTION_KEY, (value) => {
        if (value === null || typeof value !== 'object') return undefined
        const found = value[messageId]
        return Array.isArray(found) && found.length > 0 ? found : undefined
      })
      const onOpen = useCallback(() => {
        if (sources !== undefined) open(sources)
      }, [open, sources])
      if (sources === undefined) return null
      const label = sources.length === 1
        ? t('action.render')
        : t('action.renderCount', { count: sources.length })
      return h('button', {
        type: 'button',
        className: 'dshmm-action',
        title: label,
        'aria-label': label,
        onClick: onOpen,
      }, h(DiagramGlyph))
    }

    /**
     * The frame-wide viewer: one panel per open request, rendering every diagram
     * of the requested message after the reader asked for it.
     * @param props - the plugin-owned viewer source, the injected closer, and the locale seat.
     * @returns the backdrop and panel, or nothing while closed.
     */
    function MermaidViewer(props) {
      const { useViewer, close, t } = props
      const request = useViewer(state => state.request)
      const sources = request === null ? null : request.sources
      const [results, setResults] = useState(null)
      const panelRef = useRef(null)

      useEffect(() => {
        if (sources === null) {
          setResults(null)
          return undefined
        }
        let cancelled = false
        setResults(null)
        void (async () => {
          let mermaid
          try {
            mermaid = await loadMermaid()
          } catch (error) {
            if (!cancelled) setResults(sources.map(() => ({ ok: false, message: describeError(error) })))
            return
          }
          const dark = activeSchemeIsDark()
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: dark ? 'dark' : 'default',
            fontFamily: 'inherit',
            themeVariables: { fontFamily: 'inherit' },
            flowchart: { useMaxWidth: true },
            sequence: { useMaxWidth: true },
            gantt: { useMaxWidth: true },
            class: { useMaxWidth: true },
            state: { useMaxWidth: true },
            er: { useMaxWidth: true },
            journey: { useMaxWidth: true },
            pie: { useMaxWidth: true },
          })
          const rendered = []
          for (const source of sources) {
            try {
              await mermaid.parse(source)
              renderSeq += 1
              const result = await mermaid.render(`dshmm-${renderSeq}`, source)
              rendered.push({ ok: true, svg: result.svg })
            } catch (error) {
              rendered.push({ ok: false, message: describeError(error) })
            }
            if (cancelled) return
          }
          if (!cancelled) setResults(rendered)
        })()
        return () => { cancelled = true }
      }, [sources])

      useEffect(() => {
        if (sources === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // Full screen owns Escape: the browser leaves it before the dialog closes.
          if (document.fullscreenElement) return
          event.stopPropagation()
          close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [sources, close])

      useEffect(() => {
        if (sources !== null) panelRef.current?.focus()
      }, [sources])

      const onBackdrop = useCallback((event) => {
        if (event.target === event.currentTarget) close()
      }, [close])

      if (sources === null) return null
      const count = sources.length
      const title = count === 1 ? t('viewer.title') : t('viewer.titleCount', { count })
      const body = results === null
        ? h('div', { className: 'dshmm-status' }, t('viewer.loading'))
        : results.map((result, index) => result.ok
          ? h(DiagramCard, { key: index, svg: result.svg, index: index + 1, t })
          : h('div', { key: index, className: 'dshmm-failure' },
            t('viewer.renderFailed', { index: index + 1, message: result.message })))
      return h('div', {
        className: 'dshmm-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        onClick: onBackdrop,
      }, h('div', {
        ref: panelRef,
        className: 'dshmm-panel',
        tabIndex: -1,
      },
      h('div', { className: 'dshmm-header' },
        h('div', { className: 'dshmm-title' }, title),
        h('span', { className: 'dshmm-hint' }, t('viewer.hint')),
        h('button', {
          type: 'button',
          className: 'dshmm-close',
          title: t('viewer.close'),
          'aria-label': t('viewer.close'),
          onClick: close,
        }, h(CloseGlyph)),
      ),
      h('div', { className: 'dshmm-body' }, body)))
    }

    /**
     * One plugin-owned observable holding the viewer request shared by the
     * action row and the frame-wide viewer.
     * @returns the observable source plus its plugin-only writer.
     */
    function createViewerSource() {
      let snapshot = { request: null }
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (request) => {
          if (snapshot.request === request) return
          snapshot = { request }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mermaid-viewer: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-mermaid-viewer: styles')

        const viewer = createViewerSource()
        const open = sources => { viewer.set({ sources }) }
        const close = () => { viewer.set(null) }

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'mermaid',
          order: 20,
          label: 'Mermaid',
          locale: NS,
          inject: () => ({ open }),
        }, MermaidAction))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mermaid-viewer',
          order: 40,
          label: 'Mermaid viewer',
          locale: NS,
          inject: () => ({ hooks: { viewer }, close }),
        }, MermaidViewer))
      },
    }
  },
})
