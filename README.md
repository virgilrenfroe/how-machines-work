# How Machines Work

A shop / engineering lab for linkages, gears, and simple machines — by Virgil Renfroe.

**Classroom use:** Shop / engineering: gear ratio & meshing.

**Live preview (Railway):** https://web-production-03e60.up.railway.app/

**GitHub Pages:** https://virgilrenfroe.github.io/how-machines-work/

Repo: https://github.com/virgilrenfroe/how-machines-work

Single-page three.js exhibit. One shared WebGL context. The gear train is drawn with a scissor/viewport into the bench view.

## Exhibit 01 — Simple gear train

Shop / engineering: gear ratio & meshing.

- Labeled **driver**, **idler**, and **driven** gears, with tooth counts.
- Live gear ratio `N driven / N driver`, output speed, direction, and turn counters.
- Continuous external meshing. Pitch circles stay tangent. An idler changes direction and cancels out of the ratio.
- Presets: reducer (16·24·40), even (20·20·20), overdrive (36·18·18). Remove the idler to see one reversal.

The model is kinematic. It does not simulate friction, shaft windup, or chain drives.

## Local

```bash
python3 -m http.server 8877
```

Open http://127.0.0.1:8877/

## Stack

- three.js `0.170.0` (CDN import map)
- Google Fonts: Bricolage Grotesque, Instrument Sans, Space Mono
- No backend
- Railway (Caddy static via `Dockerfile`, `Caddyfile`, `railway.toml`) and GitHub Pages (`.nojekyll`)

House rendering for this lab: void `#140818`, warm brass accent, satin `MeshPhysicalMaterial` (metalness 0.32, roughness 0.45, clearcoat 0.22, anisotropy off, bloom off). Motion pauses when the tab is hidden, holds still under `prefers-reduced-motion` until play is chosen, and rebuilds after a lost WebGL context.