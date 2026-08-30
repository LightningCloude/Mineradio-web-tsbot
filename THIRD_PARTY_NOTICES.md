# Third-party notices

Unless a file or component is identified below, this distribution is licensed
under GNU GPL version 3 only (`GPL-3.0-only`); see `LICENSE`.

Third-party components keep their own licenses. Nothing in the root GPL text
relicenses a component whose copyright is owned by another party.

## Original NeteaseTSBot code

The upstream NeteaseTSBot project was distributed under the MIT License. Its
original notice is retained in `LICENSES/NeteaseTSBot-original-MIT.txt`. MIT
licensed portions may be distributed as part of this GPL-3.0 project while the
upstream notice remains intact.

Source: https://github.com/yichen11818/NeteaseTSBot

## Mineradio-derived implementation

The following areas contain code ported or adapted from Mineradio:

- audio analysis and offline beat analysis;
- particle-wall, camera, lyric-colour and 3D shelf behaviour;
- parts of the visual styling and glass treatment;
- portions of the audio-terrain integration.

Mineradio is Copyright (C) 2026 XxHuberrr and is licensed under GPL-3.0. The
upstream license and notice are included as
`LICENSES/Mineradio-GPL-3.0.txt` and `LICENSES/Mineradio-NOTICE.md`.

Source: https://github.com/XxHuberrr/Mineradio

## Sonic Topography audio terrain

Parts of `web/src/visual/SonicTopographyStage.js`, including the terrain noise,
frequency-region mapping, lift curves and peak-lighting approach, are adapted
from Sonic Topography.

Those portions remain subject to the upstream Non-Commercial Learning License
and are **not** relicensed under GPL-3.0. They are restricted to learning,
research and personal non-commercial use. The complete upstream terms are in
`LICENSES/Sonic-Topography-Non-Commercial.txt`.

Source: https://github.com/yin-yizhen/sonic-topography

## Bundled browser libraries

- Three.js r128 — MIT; see `LICENSES/Three.js-MIT.txt`.
- GSAP 3.15.0 — Standard "No Charge" GSAP License; see
  `LICENSES/GSAP-3.15.0-NOTICE.txt` and the unmodified notice in the bundled
  library.

## Vendored TeamSpeak Rust crates

`vendor/tsclientlib-0.2.0` and `vendor/tsproto-0.2.0` are licensed under
`MIT OR Apache-2.0`. Copies are retained in `LICENSES/ReSpeak-MIT.txt` and
`LICENSES/ReSpeak-Apache-2.0.txt`.
