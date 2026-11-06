/* Copyright (C) 2023-2026 QuantumNous
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type {
  ShaderMount,
  StaticMeshGradientUniforms,
} from '@paper-design/shaders'
import { useEffect, useRef } from 'react'

// Paper Shaders StaticMeshGradient with x.ai/api's api-hero seed and graphite
// palette. The original hero is static (speed 0).
export function HeroMeshBackground() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = container.current
    if (!element || typeof WebGL2RenderingContext === 'undefined') return
    let cancelled = false
    let mount: ShaderMount | undefined

    void import('@paper-design/shaders')
      .then((shader) => {
        if (cancelled) return
        const uniforms: StaticMeshGradientUniforms = {
          u_colors: ['#383838', '#4A4A4A', '#A0A0A0', '#101010', '#202020'].map(
            (color) => shader.getShaderColorFromString(color)
          ),
          u_colorsCount: 5,
          u_positions: 27.126330619795556,
          u_waveX: 0.5447748313516144,
          u_waveY: 0.7105906457366334,
          u_waveXShift: 0.47622871153636714,
          u_waveYShift: 0.2359550168932928,
          u_mixing: 0.5235813978114924,
          u_grainMixer: 0.17347495231169738,
          u_grainOverlay: 0.04676177686710076,
          u_rotation: 123.51840654808879,
          u_scale: 1.6057360121894033,
          u_offsetX: 0.272125739671407,
          u_offsetY: -0.28269328104582925,
          u_fit: 1,
          u_originX: 0.5,
          u_originY: 0.5,
          u_worldWidth: 0,
          u_worldHeight: 0,
        }
        // ShaderMount handles responsive sizing and observer cleanup.
        mount = new shader.ShaderMount(
          element,
          shader.staticMeshGradientFragmentShader,
          { ...uniforms },
          undefined,
          0,
          0,
          1
        )
      })
      .catch(() => {
        // Keep the CSS fallback if WebGL or the lazy chunk is unavailable.
        if (!cancelled) element.replaceChildren()
      })

    return () => {
      cancelled = true
      mount?.dispose()
    }
  }, [])

  return (
    <div ref={container} className='hero-mesh-background' aria-hidden='true' />
  )
}
