# How Machines Work

A shop / engineering lab for linkages, gears, and simple machines — by Virgil Renfroe.

**Live preview:** https://web-production-03e60.up.railway.app/

**GitHub Pages:** https://virgilrenfroe.github.io/how-machines-work/

## Classroom list

1. **Shop / engineering: gear ratio & meshing.** [Exhibit 01](https://web-production-03e60.up.railway.app/) · Pages: https://virgilrenfroe.github.io/how-machines-work/
2. **Shop / engineering: four-bar linkage (crank–rocker).** [Exhibit 02](https://web-production-03e60.up.railway.app/four-bar.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/four-bar.html
3. **Shop / engineering: levers (classes 1–3).** [Exhibit 03](https://web-production-03e60.up.railway.app/lever.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/lever.html
4. **Shop / engineering: pulley / block-and-tackle.** [Exhibit 04](https://web-production-03e60.up.railway.app/pulley.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/pulley.html
5. **Shop / engineering: wheel and axle.** [Exhibit 05](https://web-production-03e60.up.railway.app/wheel-axle.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/wheel-axle.html
6. **Shop / engineering: inclined plane (length ÷ height).** [Exhibit 06](https://web-production-03e60.up.railway.app/inclined-plane.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/inclined-plane.html

Repo: https://github.com/virgilrenfroe/how-machines-work

Six lesson pages. Each page uses one WebGL context. The model is drawn with a scissor/viewport into the bench view. The exhibit index is a plate: 01 Gear, 02 Four-bar, 03 Levers, 04 Pulley, 05 Wheel & axle, 06 Inclined plane.

## Exhibit 01 — Simple gear train

Shop / engineering: gear ratio & meshing.

- Labeled **driver**, **idler**, and **driven** gears, with tooth counts.
- Live gear ratio `N driven / N driver`, output speed, direction, and turn counters.
- Continuous external meshing. Pitch circles stay tangent. An idler changes direction and cancels out of the ratio.
- Presets: reducer (16·24·40), even (20·20·20), overdrive (36·18·18). Remove the idler to see one reversal.

The model is kinematic. It does not simulate friction, shaft windup, or chain drives.

## Exhibit 02 — Four-bar linkage

Shop / engineering: four-bar linkage (crank–rocker).

- Labeled ground, crank, coupler, and rocker, with joints A–B–C–D.
- Live crank angle and rocker angle. The crank turns full circle. The rocker only swings.
- Optional coupler curve traced by a point fixed on the coupler.
- Same night chrome as Exhibit 01. Reach it from the exhibit nav on the gear-train page.

## Exhibit 03 — Lever classes

Shop / engineering: levers (classes 1–3).

- First, second, and third class stay on the bench together. Fulcrum, effort, and load are labeled.
- Live mechanical advantage is effort arm / load arm. A 10 lb load shows the effort force as the arms move.
- Class 2 stays above 1 : 1. Class 3 stays below 1 : 1. Class 1 can go either way.
- Same night chrome. The exhibit index on every lesson reaches gear, four-bar, levers, pulley, wheel and axle, and the inclined plane.

## Exhibit 04 — Pulley and block-and-tackle

Shop / engineering: pulley / block-and-tackle.

- Fixed, movable, and block-and-tackle on one bench. The load stays 10 lb, the same shop weight as the lever lesson.
- Ideal mechanical advantage equals the number of rope parts holding the load. Effort is load divided by that count.
- Fixed: 1 part, 10 lb effort, pull down. Movable: 2 parts, 5 lb effort, pull up. Block and tackle: 2, 3, or 4 parts, pull down.
- Brass rope is a supporting part. The pale rope is the haul. The load rises 1 inch for every MA inches of rope.
- The model is ideal. It does not simulate friction or rope stiffness.

## Exhibit 05 — Wheel and axle

Shop / engineering: wheel and axle.

- One rigid body: a handwheel fixed to a shaft. Change either radius and both machines update.
- Ideal mechanical advantage is R wheel / R axle. That is the advantage when you drive the wheel and the load sits on the axle.
- The load stays 10 lb, same as the lever bench. The readout shows the effort to drive the wheel and the effort to drive the axle.
- Driving the axle flips the ratio. The effort rises above the load. The rim moves farther than the axle.
- Two copies stay on the bench: effort on the rim, and effort on the axle. Presets: winch (6 · 1.5), knob (2.4 · 0.6), steering (8 · 0.8).

## Exhibit 06 — Inclined plane

Shop / engineering: inclined plane (length ÷ height).

- A ramp on the bench with the load, the effort along the slope, and the angle marked.
- Ideal mechanical advantage is the slope length divided by the height. The same number is 1 / sin θ.
- The load stays 10 lb. Change the angle or the ramp length and the effort updates. Height stays in the readout because it is the other half of the ratio.
- Ideal work matches: effort × slope length equals load × height. Friction is left out.
- Same night chrome. Reach it from the exhibit index with gear, four-bar, levers, pulley, and wheel and axle.

The ramp is one extruded right triangle plus a deck plate, drawn with the page's single WebGL context through a scissor and viewport (three.js 0.170.0). Satin `MeshPhysicalMaterial` uses metalness 0.32, roughness 0.45, clearcoat 0.22, anisotropy off. Bloom is off. On a narrow viewport the pixel ratio is capped at 1.5. The model is kinematic and ideal: no friction, and no normal-force arrow. The image copies every `*.html` and `*.js` into `/srv`, so a new lesson page is not left out of the Caddy root.

## Design notes

The lesson pages speak to students and teachers. They name the machine, the radii, the load, and the effort. They do not describe type, materials, or rendering.

The chrome is a shop bench at night, in the same family as the gear, four-bar, lever, pulley, wheel and axle, and inclined plane pages. References for that family are shop and machine pages: Bearplus, tiltoootilt’s weight studies, nexstudio’s type and energy, and rubenmarcus. The lab does not use a SaaS dashboard, a dark-and-cream marketing shell, or penguin and city-shell layouts.

- Type: Bricolage Grotesque, Instrument Sans, Space Mono
- Void `#140818`, brass accent `#f0a05a`, paper `#f4efe6`
- Satin `MeshPhysicalMaterial`: metalness 0.32, roughness 0.45, clearcoat 0.22
- Anisotropy off, bloom off
- One WebGL context per page
- Device pixel ratio on the wheel-and-axle page capped at 1.5
- three.js `0.170.0`

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

House rendering is listed under Design notes. Motion pauses when the tab is hidden, holds still under `prefers-reduced-motion` until play is chosen, and rebuilds after a lost WebGL context.