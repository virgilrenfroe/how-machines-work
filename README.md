# How Machines Work

A shop / engineering lab for linkages, gears, and simple machines — by Virgil Renfroe.

**Live preview:** https://web-production-03e60.up.railway.app/

**GitHub Pages:** https://virgilrenfroe.github.io/how-machines-work/

## Classroom list

1. **Shop / engineering: gear ratio & meshing.** [Exhibit 01](https://web-production-03e60.up.railway.app/) · Pages: https://virgilrenfroe.github.io/how-machines-work/
2. **Shop / engineering: four-bar linkage (crank–rocker).** [Exhibit 02](https://web-production-03e60.up.railway.app/four-bar.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/four-bar.html
3. **Shop / engineering: levers (classes 1–3).** [Exhibit 03](https://web-production-03e60.up.railway.app/lever.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/lever.html
4. **Shop / engineering: screw (helical incline — pitch vs effort).** [Exhibit 07](https://web-production-03e60.up.railway.app/screw.html) · Pages: https://virgilrenfroe.github.io/how-machines-work/screw.html

Repo: https://github.com/virgilrenfroe/how-machines-work

Four lesson pages. Each page uses one WebGL context. The model is drawn with a scissor/viewport into the bench view.

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
- Same night chrome. The exhibit nav on every lesson reaches gear, four-bar, levers, and the screw.

## Exhibit 07 — Screw

Shop / engineering: screw (helical incline — pitch vs effort).

- A screw is an inclined plane wrapped around a cylinder. The wedge above the screw is one turn of thread, unwrapped: base is the mean circumference, rise is the pitch.
- Ideal mechanical advantage is mean circumference ÷ pitch. The clamp stays 10 lb. Effort is that load divided by the advantage, tangent to the thread.
- Pitch slider and presets sit on the readout. Fine is 0.100 in, Vise is 0.200 in, Coarse is 0.400 in, on a 1.00 in mean diameter. Doubling the pitch halves the advantage and doubles the effort.
- One turn advances the jaw by exactly one pitch. A finer pitch creeps; a coarser pitch travels farther and takes more tangential effort.
- Same night chrome. Reach it from the exhibit nav on gear, four-bar, and levers.

The model leaves out friction and any wrench longer than the thread. A real vise handle is a second lever on top of this screw.

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

## Design notes

These notes are for people building the lab. They are not shown on the lesson pages. Learner copy stays with the shop class: what the machine does, and what to measure.

- Type: Bricolage Grotesque for display, Instrument Sans for body, Space Mono for readouts. Space Grotesk is the display fallback.
- Void `#140818`, warm brass accent, paper `#f4efe6`. Satin `MeshPhysicalMaterial`: metalness 0.32, roughness 0.45, clearcoat 0.22. Anisotropy off. Bloom off. No dark-and-cream product chrome.
- three.js `0.170.0`. One WebGL context per page. The model is scissored into the bench view.
- Exhibit 07 caps device pixel ratio at 1.5. Motion pauses while the tab is hidden, holds still when the visitor asks for reduced motion until Play is chosen, and rebuilds the screw after a lost WebGL context. None of that status is written on the page.
- The image ships with `COPY *.html *.js README.md .nojekyll /srv/`, so a new lesson page is included without editing the file list.