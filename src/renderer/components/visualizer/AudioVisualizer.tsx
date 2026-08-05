import React, { useEffect, useRef } from 'react'
import { SPECTRUM_BANDS } from '../../../shared/types'
import type { VoiceInputMode } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'

/**
 * Canvas spectrum analyser for the live microphone signal.
 *
 * It reads the shared spectrum buffer from its own animation frame instead of
 * React state: the bands update ~30×/s and re-rendering the tree at that rate
 * would cost far more than drawing does. Every bar carries its own attack and
 * release envelope plus a decaying peak cap, which is what separates a real
 * analyser from a row of boxes scaled by one loudness number.
 */

const ATTACK = 0.42
const RELEASE = 0.11
const PEAK_FALL = 0.0075
const IDLE_WAVE_SPEED = 0.0016

type Variant = 'overlay' | 'panel'

interface AudioVisualizerProps {
  active: boolean
  variant?: Variant
  mode?: VoiceInputMode
  className?: string
  label?: string
}

interface Palette {
  stops: Array<[number, string]>
  glow: string
  bloom: string
  spine: string
}

const PALETTES: Record<VoiceInputMode, Palette> = {
  normal: {
    stops: [
      [0, 'rgba(34, 211, 238, 0.95)'],
      [0.28, 'rgba(109, 139, 255, 0.98)'],
      [0.5, 'rgba(167, 139, 250, 1)'],
      [0.72, 'rgba(109, 139, 255, 0.98)'],
      [1, 'rgba(34, 211, 238, 0.95)'],
    ],
    glow: 'rgba(109, 139, 255, 0.65)',
    bloom: 'rgba(109, 139, 255, 0.20)',
    spine: 'rgba(148, 170, 255, 0.16)',
  },
  meta: {
    stops: [
      [0, 'rgba(110, 231, 234, 0.9)'],
      [0.26, 'rgba(167, 139, 250, 1)'],
      [0.5, 'rgba(240, 171, 252, 1)'],
      [0.74, 'rgba(167, 139, 250, 1)'],
      [1, 'rgba(110, 231, 234, 0.9)'],
    ],
    glow: 'rgba(196, 149, 255, 0.7)',
    bloom: 'rgba(168, 120, 255, 0.24)',
    spine: 'rgba(214, 178, 255, 0.18)',
  },
}

const VARIANTS: Record<Variant, { gap: number; minBar: number; radius: number; floor: number }> = {
  overlay: { gap: 1.5, minBar: 2, radius: 1.6, floor: 0.055 },
  panel: { gap: 2, minBar: 2.5, radius: 2, floor: 0.06 },
}

/** Mirrors the bands so low frequencies sit at the centre and highs at the edges. */
function mirrorBands(bands: Uint8Array, target: Float32Array): void {
  const half = bands.length
  for (let index = 0; index < half; index++) {
    const value = bands[half - 1 - index] / 255
    target[index] = value
    target[target.length - 1 - index] = value
  }
}

function roundedBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
  context.fill()
}

export function AudioVisualizer({
  active,
  variant = 'panel',
  mode = 'normal',
  className,
  label = '실시간 마이크 스펙트럼',
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef(0)
  const levelsRef = useRef(new Float32Array(SPECTRUM_BANDS * 2))
  const targetsRef = useRef(new Float32Array(SPECTRUM_BANDS * 2))
  const peaksRef = useRef(new Float32Array(SPECTRUM_BANDS * 2))
  const activeRef = useRef(active)
  const modeRef = useRef(mode)

  activeRef.current = active
  modeRef.current = mode

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const geometry = VARIANTS[variant]
    let width = 0
    let height = 0
    let disposed = false

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(canvas)

    const draw = (time: number) => {
      if (disposed) return
      frameRef.current = requestAnimationFrame(draw)
      if (width === 0 || height === 0) return

      const palette = PALETTES[modeRef.current]
      const state = useAppStore.getState()
      const levels = levelsRef.current
      const targets = targetsRef.current
      const peaks = peaksRef.current
      const barCount = levels.length
      const centre = height / 2
      const maxBar = centre - 2

      if (activeRef.current) {
        mirrorBands(state.spectrum, targets)
      } else {
        // Idle breathing: two travelling waves at slightly different speeds so
        // the panel reads as a live instrument waiting for input rather than a
        // flat rule. The second wave keeps the motion from looking periodic.
        for (let index = 0; index < barCount; index++) {
          const phase = time * IDLE_WAVE_SPEED + index * 0.22
          const ripple = Math.sin(phase) * 0.5 + Math.sin(phase * 0.43 + 1.7) * 0.25
          const envelope = 1 - Math.abs(index - barCount / 2) / (barCount / 2)
          targets[index] = Math.max(0, 0.5 + ripple) * (0.25 + envelope * 0.75) * 0.3 + 0.02
        }
      }

      context.clearRect(0, 0, width, height)

      const overallLevel = activeRef.current ? Math.min(1, state.audioLevel) : 0.05

      // Bloom behind the bars, tied to loudness.
      if (overallLevel > 0.02) {
        const bloom = context.createRadialGradient(width / 2, centre, 0, width / 2, centre, width / 2)
        bloom.addColorStop(0, palette.bloom)
        bloom.addColorStop(1, 'rgba(0,0,0,0)')
        context.globalAlpha = Math.min(1, 0.25 + overallLevel * 0.75)
        context.fillStyle = bloom
        context.fillRect(0, 0, width, height)
        context.globalAlpha = 1
      }

      // Centre spine keeps the mirrored layout legible when the signal is quiet.
      context.fillStyle = palette.spine
      context.fillRect(0, centre - 0.5, width, 1)

      const gradient = context.createLinearGradient(0, 0, width, 0)
      for (const [offset, color] of palette.stops) gradient.addColorStop(offset, color)

      const slot = width / barCount
      const barWidth = Math.max(1, slot - geometry.gap)

      context.save()
      context.fillStyle = gradient
      context.shadowColor = palette.glow
      context.shadowBlur = 6 + overallLevel * 22

      for (let index = 0; index < barCount; index++) {
        const target = Math.min(1, targets[index])
        const current = levels[index]
        // Fast attack, slow release: the shape tracks a syllable's onset but
        // does not flicker between frames.
        levels[index] = current + (target - current) * (target > current ? ATTACK : RELEASE)
        const value = Math.max(geometry.floor, levels[index])
        const barHeight = Math.max(geometry.minBar, value * maxBar)
        const x = index * slot + geometry.gap / 2
        roundedBar(context, x, centre - barHeight, barWidth, barHeight * 2, geometry.radius)

        peaks[index] = Math.max(peaks[index] - PEAK_FALL, levels[index])
      }
      context.restore()

      // Decaying peak caps.
      if (activeRef.current) {
        context.save()
        context.globalAlpha = 0.5
        context.fillStyle = gradient
        for (let index = 0; index < barCount; index++) {
          const peak = peaks[index]
          if (peak <= geometry.floor + 0.02) continue
          const y = centre - Math.max(geometry.minBar, peak * maxBar)
          const x = index * slot + geometry.gap / 2
          context.fillRect(x, y - 1.5, barWidth, 1.2)
          context.fillRect(x, centre + Math.max(geometry.minBar, peak * maxBar) + 0.3, barWidth, 1.2)
        }
        context.restore()
      }
    }

    frameRef.current = requestAnimationFrame(draw)
    return () => {
      disposed = true
      cancelAnimationFrame(frameRef.current)
      observer?.disconnect()
    }
  }, [variant])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={label}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
