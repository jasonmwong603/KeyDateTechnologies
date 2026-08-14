/**
 * Session codes name a private world instance so a group of friends lands in
 * the same shard. They get read aloud over voice chat and typed on phones, so
 * the alphabet drops every glyph pair that gets misheard or misread: I/1, O/0,
 * and the digits entirely. What is left is 24 unambiguous uppercase letters.
 */
export const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SESSION_CODE_LENGTH = 5;

/** Generates a session code from the supplied random source (0 <= r() < 1). */
export function generateSessionCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < SESSION_CODE_LENGTH; i += 1) {
    const index =
      Math.floor(random() * SESSION_CODE_ALPHABET.length) % SESSION_CODE_ALPHABET.length;
    code += SESSION_CODE_ALPHABET[index];
  }
  return code;
}

/**
 * Accepts what a player actually types — lowercase, surrounding whitespace,
 * and the classic O-for-zero / I-for-one substitutions folded back onto the
 * letters that are actually in the alphabet. Returns null when the result is
 * still not a legal code.
 */
export function normalizeSessionCode(input: string): string | null {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/[^A-Z]/g, '');

  if (cleaned.length !== SESSION_CODE_LENGTH) return null;

  // O and I are excluded from the alphabet; fold them onto their look-alikes.
  const folded = cleaned.replace(/O/g, 'Q').replace(/I/g, 'J');
  return isSessionCode(folded) ? folded : null;
}

export function isSessionCode(value: string): boolean {
  if (value.length !== SESSION_CODE_LENGTH) return false;
  return [...value].every((char) => SESSION_CODE_ALPHABET.includes(char));
}
