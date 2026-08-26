/**
 * Field rules shared by the browser and the API.
 *
 * The point is that there is exactly ONE definition of each. A client-side check
 * that is STRICTER than the server rejects input the server would have accepted, and
 * one that is LOOSER lets the user submit and get a 400 with no idea which field it
 * came from — both read to the user as the form being broken. Importing the same
 * function on both sides makes drift impossible rather than merely unlikely.
 *
 * These are for instant feedback in the UI. They do not replace server validation:
 * the API still checks everything, because a browser check is a courtesy, not a gate.
 */

/** Deliberately permissive: one @, a dot in the domain, no whitespace. Anything
 *  tighter starts rejecting addresses that are legal and in use (plus-tags, unicode
 *  domains, single-letter TLDs are not worth the false negatives). */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(email: unknown): boolean {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/** Mirrors passwordPolicyError() in lib/password.ts — keep the two in step. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export type PasswordProblem = 'required' | 'tooShort' | 'tooLong';

/** The problem with a password, or null when it is acceptable. Returns a KEY rather
 *  than a message so the caller supplies its own translation. */
export function passwordProblem(pw: string): PasswordProblem | null {
  if (!pw) return 'required';
  if (pw.length < PASSWORD_MIN) return 'tooShort';
  if (pw.length > PASSWORD_MAX) return 'tooLong';
  return null;
}
