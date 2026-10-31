# Snapshot

_An app in [KeyDate Magic](../../README.md). Served at `/snapshot`; only `public/` is
published — this file is not._

A card under the glass. The phone looks like it is sitting idle on its home screen, and
a corner of a playing card is lying on it — not drawn on it, under it, continuing past
the edge of the screen. You can put a finger on the corner and slide it around.

## The state of it

The card, the drag and the perspective work and are proved. **It is not a finished
routine yet** — there is no reveal, no change, no method. It is the object; what happens
to it is still to be designed.

## The handling, so far

1. **Install it and open it.** There is no setup. It opens as a dark phone with a card
   lying on it.
2. **Size it once.** Two fingers held anywhere for a second opens the settings. Hold a
   real card flat against the screen and move the slider until the drawn one matches it
   exactly. This matters more than anything else on this page — see below.
3. **Pick the card** it should be, in the same panel.
4. Then it is a phone that looks asleep with a card under the glass.

## Why the background is black and nothing else

The first version asked for a screenshot of the performer's own home screen. It looked
right and was wrong, because a screenshot drifts: notification badges change, the status
bar clock is frozen at whatever minute it was taken, the wallpaper rotates. The moment
the fake home screen stops matching the real one, the illusion breaks on the way _out_
of it — which is the worst moment available, because that is when the phone is being
handed back and looked at properly.

Black never drifts. On an OLED phone those pixels are switched off, so the screen is not
showing black, it _is_ black, and indistinguishable from a phone that is asleep. A card
lying on it reads as an object on dark, inert glass, which is the premise rather than a
compromise with it.

It also needs no setup, fits every phone, keeps the performer's notification counts out
of a prop, and retires a megabyte or three of somebody's private life sitting in local
storage against a quota of about five.

## Why the size slider exists

Everybody in the room has held thousands of playing cards. A card rendered a few
millimetres too large is wrong in a way every one of them can see and none of them can
name, and it reads as _fake_ long before anybody works out why.

The browser cannot be asked how big a millimetre is. CSS has `mm`, but on a phone it is
a fiction — a fixed ratio to a 96dpi CSS pixel, not a measurement of the glass. So it is
measured once, against a real card, and kept.

## What the checks prove

```bash
node check.mjs    # the geometry, from a terminal
node smoke.mjs    # the app in a real browser, through the real host, with real touches
```

`check.mjs` proves the one property the illusion cannot survive being wrong about: **the
point of the card under your fingertip stays under it.** A real object does. Anything
that slides, lags or drifts by a millimetre over a long drag reads as a graphic at once,
and no amount of shadow or gloss gets it back. It is checked across 24,000 drag steps at
every pose, and holds to floating-point exactness — along with the card keeping its shape
while it moves, and being the size of a card.

That it is geometry, and therefore provable without a phone, is why it was built this
way round: the part that must be exact is the part a terminal can settle.

## What this cannot do, and why

**It cannot float over your other apps.** Not a shortcoming of this being a web app — on
iOS nothing can. There is no equivalent of Android's "draw over other apps" permission;
the only things that appear above another app are Apple's own: notifications, Live
Activities, the Dynamic Island, Picture-in-Picture. A native app written for this would
hit the same wall.

The way round it is the one a prop should take anyway: **do not fight the phone, be the
phone.** What the app shows is the performer's own screenshot, so it already looks like
an idle home screen rather than a running app. Extending that to several screenshots —
swipe between pages, "open" an app, all of them pictures inside this one page — gives
the whole effect of using the phone normally with the card riding on top, because the
card and the "phone" are the same page and nothing has to cross a boundary iOS does not
open.

The honest cost of that: you can only "use" the screens you have screenshots of.

## Parked

The first direction was to film a real card and change its face on screen. The geometry
for it is complete and tested — card-finding by edge-line intersection, exact
perspective transform, rejection of things that are not cards — and sits at commit
`68a3d0a` if it is ever wanted back.

It was parked for a better reason than difficulty. Camera access from an installed
home-screen app on iOS has been unreliable for years, with reports as recent as iOS 18.5
of the stream failing in standalone mode and of permission prompts reappearing after
navigation. A permission dialog in the middle of a trick is not a bug you can recover
from on stage.
