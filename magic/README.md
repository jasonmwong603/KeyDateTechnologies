# Clockwork

A phone calculator that is a real calculator, and once per performance is not.

Four spectators, and nothing is forced. Two call out free numbers and you add
them. A third taps a screen she cannot see, and the product goes up on the
display for the room to look at. A fourth taps, and the total is today's date
and the time on the clock — with every calculator in the room agreeing, because
the arithmetic is genuine throughout.

```
4827 + 3915 = 8742              the first two, said aloud
8742 × 1175 = 10,271,850        the third, and a real product to show
10,271,850 + 9,183 = 10281033   the fourth  →  10/28, 10:33
```

## Installing it on the phone

Open **<https://play.keydate.ca/calc/>** in Safari, then **Share → Add to Home
Screen**.

Do that once, on wifi, at home. Two things happen: the shortcut launches without
Safari's address bar and tab strip — with those on screen nobody believes it is
the system calculator — and a service worker puts the files on the phone, so it
opens with no signal at all.

That second part is not a nicety. Adding a page to the home screen saves a
bookmark, not the page; without the worker, tapping it in a basement with no
bars gets you an error in front of an audience. Check it before you rely on it:
put the phone in aeroplane mode and open the app. If it loads, you are done.

### Updating it

Open the app with signal and it fetches the current page; if the network is
slow or absent it uses the copy on the phone, so it still opens instantly in a
basement. When a new version does arrive it reloads itself once, there and then.

To confirm which build is on the phone, hold the keypad icon: the build number
is at the foot of the crib card. If it is behind what you expect, delete the
home-screen icon, reopen the address in Safari and add it again.

An earlier version fetched the page from the phone first and the network second,
and the consequence was not abstract: a release went out, the phone kept running
the copy it already had, and the screenshots coming back were of code that had
been replaced days earlier. The page is fetched fresh now. Everything else — the
icons, the manifest — still comes straight off the phone, because none of it
changes.

The path is `/calc` and should stay dull. The address is visible exactly once,
in the browser chrome while you are installing it, and a URL that says what it
is would be the only thing in the whole routine that gives it away. Change it
with `CALCULATOR_SLUG` on the host; set it empty to stop serving it.

## The handling

1. **First spectator** calls any 3- or 4-digit number. Type it. Press `+`.
2. **Second spectator** calls another. Type it. Press `=`.
   The sum is on screen — say it aloud, it is the number the room will work from.
3. **Press and hold `×`** for half a second. The key turns white: that is your
   confirmation. A normal tap of `×` multiplies as usual and arms nothing.
4. **Turn the phone face down.** Third spectator taps the screen. _"As many times
   as you like"_ — and mean it. Too many are swallowed; too few are finished for
   her the moment you take the phone back. You never have to count.
5. **Take the phone back and press and hold anywhere** for half a second to
   release the keypad. Her number is on the display — show it to her, show it to
   the room.
6. **Press `=`.** A genuine seven- or eight-figure product. Let it sit there.
   This is the middle of the routine and it is doing real work: the room has a
   number to look at that plainly came from her taps, and nothing has happened
   yet that could be the trick.
7. **Press and hold `+`** for half a second. It turns white the same way, and a
   normal tap of `+` still just adds.
8. **Phone face down again**, a _fourth_ spectator this time, same instruction.
9. **Take it back, press and hold to release, then `=`.**
10. **Turn the phone sideways** if you want the reveal bigger. The keypad
    rearranges the way the system one does, and the answer and the sum above it
    each sit on one comfortable line.

The screen reads the date and time, and the closing sum is above it for anyone
who wants to check.

### Why the second half is `+` and not another `×`

Because a second multiply cannot work and no amount of code will make it. After
the first reveal the screen holds `P = S × C`. For `P × D` to land on the clock,
`P` would have to divide the clock exactly — and since `P` is built on a sum the
audience chose, that needs `S` to divide `T`, which happens about once in `S`
performances.

Multiplication only scales. A remainder is the one operation that can absorb an
arbitrary leftover, and the leftover here is handed to you by a clock you do not
control. So the first half scales the sum up to just under the target and the
second half closes the gap. The two halves look alike from the front, which is
all that matters.

### The gap is measured when you arm it

The second number is worked out against the clock at the moment you hold `+`,
not the one read when you held `×`. So however long you spend on the middle
reveal — a minute of patter, a question from the floor, someone checking the
product on their own phone — the final number is still the time it actually is
when you get there. The delay corrects itself, and you can take as long over the
middle beat as it deserves.

Rotating is safe at any point in the routine. Nothing about the arithmetic or the
blind taps depends on which way up the phone is, so you can turn it before you
start, hand it over sideways, or leave it upright throughout.

### Reading it across a room

The answer is eight digits and three commas and does not fit a phone held
upright at full size. It shrinks until it does, exactly as the system calculator
does — it is never cut off, in either orientation. That is the part that was
broken, and it is fixed in both.

Landscape is not a bigger number, and an earlier draft of this file claimed it
was. A phone turned sideways is as tall as it was wide, and the readout now
shares that height with four rows of keys, so the digits come out slightly
smaller than upright — 64px against 61px on a 13 Pro, and smaller than portrait
on the larger phones. What landscape actually gives you is the layout: the
keypad the room recognises, the whole expression on one comfortable line above
the answer, and no shrinking to fit.

### The crib, on the phone

Press and hold the **keypad icon, top right** for most of a second: the handling
appears as a card. Tap anywhere to dismiss it.

It is behind a hold for the same reason the rehearsal readout is — nothing that
can appear on this screen by accident is worth having. Use it in the green room,
not on stage.

### Rehearsing

Press and hold the clock icon, top left, to show what the spectator in front of
you is about to tap and how many taps it needs. It updates for each half, so
hold `×`, read it, then hold `+` later and read it again. Hold the icon a second
time to hide it. Do this before you ever perform it — not because the maths
fails, but so you believe it.

## Why they tap more than three times

The obvious version has her tap a 3-digit number and multiplies by it. It cannot
work. You need

```
(A + B) × C = T
```

where `T` is the clock. `A` and `B` belong to the audience, so their sum `S` is
whatever they make it, and `C = T / S` is a whole number only when `S` happens to
divide `T` — about once in `S` tries, so a few times in a thousand performances.
One blind number is one knob, and one knob cannot hit a target you do not
control.

Two knobs can:

```
S × C + D = T
```

There is always a solution — take `C` near `T / S` and let `D` be the remainder.
Nothing is forced, nobody is steered, all four spectators are genuinely free,
and the whole correction hides in taps they cannot see. The price is that `C` and
`D` together have to carry about as many digits as `T`: seven to nine taps in
all. There is no way around that — you are pinning down an eight-digit target,
and eight digits have to come from somewhere.

Splitting them between two spectators is what makes that price invisible. One
person tapping nine times is a long, odd beat; two people tapping four each,
with a real product revealed in between, is two short ones. `C` is also stepped
down by one from `floor(T / S)`, purely so the second number lands in `[S, 2S)`
and the fourth spectator always has four or five taps to make rather than
possibly one. The arithmetic is untouched by that: `S × C + D` is still exactly
`T`, which is the only thing the room can check.

### Things that would have broken it

- **Operator precedence.** Calculators do `×` before `+`, so typing
  `A + B × C` gives `A + (B × C)`, not `(A + B) × C`. Pressing `=` after the
  addition fixes it, and reads better anyway. After that, `× C + D =` evaluates
  correctly on any calculator in the room.
- **Seconds instead of minutes.** `MMDDHHSS` at 10:33:17 gives `10281017`, and
  every phone in the room says **10:33** — they read the trailing digits as
  minutes and see a mismatch. Minutes are also the only part they can actually
  check.
- **A fixed tap count.** Tempting, and impossible: for a round sum like 1000 the
  remainder is pinned to `D = 33, 1033, 2033 …` and can never reach the digit
  band that would make the total come out even. Hence "as many as you like",
  which is better patter regardless.
- **Arming on every `×`.** An early version did, so an innocent `12 + 3 × 4` put
  the invisible overlay up and left the calculator dead. It has to survive being
  picked up and used.
- **Trusting the display instead of the sum.** `arm` read whatever number was on
  screen, which is the sum only if you pressed `=` after the addition. Forget
  that one keystroke — in the middle of talking to a room — and it armed against
  the second spectator's number alone. Everything downstream still looked
  right: the key went white, she tapped, the sum appeared, and the total was out
  by the first spectator's number exactly. Nothing on screen said so. It now
  settles the sum itself, so both routes end identically.
- **Stopping her early.** Extra taps were swallowed, but _too few_ left the rest
  of the digits unentered and the total quietly wrong — and worse, the press and
  hold only worked once her digits ran out, so stopping her short left no way
  out at all: the hold just entered another digit and every key stayed behind
  the overlay. "Tap as many times as you like" now means it in both directions.
- **Clipping the answer from the left.** The readouts were laid out
  right-to-left, which looks identical until a number outgrows the screen — and
  then eats the _most significant_ digits. `10,280,533` showing as `280,533` is
  worse than an error, because nothing on screen says anything is missing and
  the room checks a number that was never there. They are right-aligned and
  shrink to fit instead.
- **Locking the installed app to portrait.** The manifest said
  `"orientation": "portrait"`, which an installed home-screen app obeys — the
  phone would simply never have turned over, however the page was styled.

### Why not more multiplications

Chaining them changes nothing, because they collapse:

```
(A + B) × C₁ × C₂ × C₃ × C₄  =  S × (C₁C₂C₃C₄)  =  S × K
```

Four multiplications are one multiplication wearing a hat, and `S` still has to
divide `T` exactly. Measured over a day of clock readings: with a free sum, only
15% of spectator pairs have _any_ workable minute in the whole day — and that is
allowing you to wait all day for it. Forcing the sum does not rescue it either;
most forced values have no workable minute at all.

The trailing `+` is load-bearing. It is a remainder, and a remainder is the only
thing that can absorb an arbitrary leftover — which is what you need when the
target is handed to you by a clock. Multiplication only scales; it cannot
correct.

Splitting the blind multiplier into factors is available as _presentation_ — she
taps several small numbers and you multiply each, which looks like more free
choices while being the same number underneath. It usually costs more taps than
it saves, and it is impossible whenever the multiplier comes out prime.

This is also why the routine's second half is `+`. It is the same wall seen from
the other side: once the product `P = S × C` is on screen, `P × D = T` needs `P`
to divide `T`, which needs `S` to divide `T`. What the two halves buy is not more
arithmetic but better staging — two spectators tapping four times each, with a
real product shown in between, instead of one tapping nine times.

### January to September

Months `01`–`09` lose their leading zero, exactly as a calculator would show
them: 5 March reads `3051012`, not `03051012`. Worth a word in the patter if you
perform it in those months.

## Checking it

```bash
node check.mjs    # the arithmetic, across a year of clock times and every shape of number
node smoke.mjs    # drives a real browser: layout, ordinary use, then the trick end to end
```

`check.mjs` is the one that matters. If it ever reports less than 100% exact, the
room's calculators disagree with the phone and the trick is dead.
