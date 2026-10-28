// Checks the trick's arithmetic across a wide spread of spectator numbers and
// clock times. Run with: node /home/user/KeyDateTechnologies/magic/check.mjs
//
// The two properties that matter on stage:
//   1. S x C + D really equals the timestamp. If this is ever off by one, the
//      room's calculators disagree with the phone and the trick dies.
//   2. How many taps each of the two spectators needs. Neither can overrun —
//      extra taps are swallowed and a number left short is finished when you
//      take the phone back — but a spectator with only one or two taps to make
//      is a thin moment, so the spread matters to the handling.

function stamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return Number(
    `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`,
  );
}

/*
 * The two blind numbers.
 *
 * The honest version is plain division with remainder: C = floor(T / S) and D
 * is what is left. That is exact, but D is then uniform in [0, S) and nothing
 * stops it coming out as 7, or 0 — and a second spectator who taps the screen
 * once, for a one-digit number, is a thin moment in the middle of the routine
 * and an invitation to wonder what she contributed.
 *
 * So C is stepped down by one. D grows by exactly S, which puts it in [S, 2S)
 * — always four or five digits for two 4-digit spectator numbers, so she always
 * has a handful of taps to make. The arithmetic is untouched: S x C + D is
 * still exactly T, which is the only thing the room can check.
 */
function solve(sum, target) {
  if (!Number.isInteger(sum) || sum < 1 || target < 1) return null;
  const whole = Math.floor(target / sum);
  // Step down only when there is room to; at whole === 1 the multiplier would
  // go to zero and the product with it.
  const c = whole > 1 ? whole - 1 : whole;
  if (c < 1) return null;
  return { c, d: target - sum * c };
}

let checked = 0;
let exact = 0;
const misses = [];
const taps = [];
const first = [];
const second = [];

// Every minute of a whole year, against spectator numbers of every plausible
// shape: two 3-digit, two 4-digit, and one of each.
for (let month = 1; month <= 12; month += 1) {
  for (const day of [1, 14, 28]) {
    for (const hour of [0, 9, 15, 23]) {
      for (const minute of [0, 7, 33, 59]) {
        const target = stamp(new Date(2026, month - 1, day, hour, minute));

        for (const [lo, hi] of [
          [100, 999],
          [1000, 9999],
        ]) {
          for (const [lo2, hi2] of [
            [100, 999],
            [1000, 9999],
          ]) {
            for (let trial = 0; trial < 6; trial += 1) {
              const a = lo + Math.floor(Math.random() * (hi - lo + 1));
              const b = lo2 + Math.floor(Math.random() * (hi2 - lo2 + 1));
              const sum = a + b;
              const answer = solve(sum, target);
              checked += 1;

              if (answer === null) {
                misses.push({ a, b, target, reason: 'no solution' });
                continue;
              }
              if (sum * answer.c + answer.d === target) exact += 1;
              else misses.push({ a, b, target, answer, reason: 'arithmetic wrong' });

              taps.push(String(answer.c).length + String(answer.d).length);
              first.push(String(answer.c).length);
              second.push(String(answer.d).length);
            }
          }
        }
      }
    }
  }
}

console.log(`checked          ${checked}`);
console.log(`arithmetic exact ${exact}  (${((exact / checked) * 100).toFixed(2)}%)`);
const span = (list) => {
  const sorted = list.slice().sort((a, b) => a - b);
  return `${sorted[0]}-${sorted.at(-1)}  (median ${sorted[Math.floor(sorted.length / 2)]})`;
};
console.log(`taps, first      ${span(first)}`);
console.log(`taps, second     ${span(second)}`);
console.log(`taps, both       ${span(taps)}`);
if (misses.length > 0) {
  console.log(`\nmisses (${misses.length}), first few:`);
  for (const miss of misses.slice(0, 5)) console.log(' ', JSON.stringify(miss));
}

// And the worked example from the conversation, pinned exactly.
const target = stamp(new Date(2026, 9, 28, 10, 33));
const answer = solve(4827 + 3915, target);
console.log(
  `\nworked example   (4827 + 3915) = ${4827 + 3915}` +
    ` -> x ${answer.c} + ${answer.d} = ${(4827 + 3915) * answer.c + answer.d}` +
    `  (want ${target})`,
);
