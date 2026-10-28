# Clockwork

A phone calculator that is a real calculator, and once per performance is not.

Two spectators each call out a free number. You add them. A third taps a screen
she cannot see. The total is today's date and the time on the clock — and every
calculator in the room agrees, because the arithmetic is genuine.

```
(4827 + 3915) = 8742
8742 × 1175 + 9183 = 10281033     →  10/28, 10:33
```

## Running it

Open `index.html` on the phone, then **Share → Add to Home Screen**. That drops
Safari's address bar and tab strip, which matters more than it sounds: with them
on screen nobody believes it is the system calculator.

Everything is in the one file. No network, no fonts to fetch, nothing to go
stale — it works in a basement with no signal, which is where it will be used.

## The handling

1. **First spectator** calls any 3- or 4-digit number. Type it. Press `+`.
2. **Second spectator** calls another. Type it. Press `=`.
   The sum is on screen — say it aloud, it is the number the room will work from.
3. **Press and hold `×`** for half a second. The key turns white: that is your
   confirmation, and the only thing you have to remember. A normal tap of `×`
   multiplies as usual and arms nothing.
4. **Turn the phone face down.** Third spectator taps the screen. _"As many times
   as you like"_ — nine is the most it ever needs, and extra taps are swallowed.
5. **Take the phone back and press and hold anywhere** for half a second to
   release the keypad. Then `=`.

The screen reads the date and time, and the whole sum is above it for anyone who
wants to check.

### Rehearsing

Press and hold the clock icon, top left, to show what she is about to tap and how
many taps it needs. Hold it again to hide it. Do this before you ever perform it
— not because the maths fails, but so you believe it.

## Why she taps more than three times

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
Nothing is forced, nobody is steered, all three spectators are genuinely free,
and the whole correction hides in taps she cannot see. The price is that `C` and
`D` together have to carry about as many digits as `T`, which is why she taps
seven or eight times rather than three. There is no way around that: you are
pinning down an eight-digit target, and eight digits have to come from somewhere.

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
