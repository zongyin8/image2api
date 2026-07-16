<script setup>
// Vivid mark: a violet→fuchsia rounded badge with a faceted, folded "V".
// Self-contained SVG so it renders identically on dark and light shells.
// Each instance gets unique gradient ids (useId) so multiple logos on one
// page don't share/clobber defs.
import { useId } from 'vue'

defineProps({ size: { type: [Number, String], default: 40 } })

const uid = useId()
const gBg = `vbg-${uid}`
const gGloss = `vgl-${uid}`
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 48 48" fill="none"
       xmlns="http://www.w3.org/2000/svg" class="shrink-0">
    <defs>
      <linearGradient :id="gBg" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
        <stop stop-color="#a855f7" />
        <stop offset="0.55" stop-color="#7c3aed" />
        <stop offset="1" stop-color="#ec4899" />
      </linearGradient>
      <linearGradient :id="gGloss" x1="24" y1="2" x2="24" y2="30" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ffffff" stop-opacity="0.28" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
      </linearGradient>
    </defs>

    <!-- badge -->
    <rect x="2" y="2" width="44" height="44" rx="13" :fill="`url(#${gBg})`" />
    <!-- top gloss for depth -->
    <rect x="2" y="2" width="44" height="22" rx="13" :fill="`url(#${gGloss})`" />

    <!-- sparkle mark (AI 生成):主星芒 + 右上小星,替代原来的 V -->
    <path d="M24 10.5 C24.7 18.2 29.8 23.3 37.5 24 C29.8 24.7 24.7 29.8 24 37.5 C23.3 29.8 18.2 24.7 10.5 24 C18.2 23.3 23.3 18.2 24 10.5 Z" fill="#ffffff" fill-opacity="0.95" />
    <path d="M33.5 11 C33.8 13.9 34.6 14.7 37.5 15 C34.6 15.3 33.8 16.1 33.5 19 C33.2 16.1 32.4 15.3 29.5 15 C32.4 14.7 33.2 13.9 33.5 11 Z" fill="#ffffff" fill-opacity="0.7" />
  </svg>
</template>
