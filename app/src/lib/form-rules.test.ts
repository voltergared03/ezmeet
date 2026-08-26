import { describe, it, expect } from 'vitest';
import { isValidEmail, passwordProblem, PASSWORD_MIN } from '@/lib/form-rules';
import { passwordPolicyError } from '@/lib/password';

describe('isValidEmail', () => {
  it('accepts ordinary and plus-tagged addresses', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.domain.co.uk')).toBe(true);
  });
  it('trims before judging — a pasted address usually carries a space', () => {
    expect(isValidEmail('  a@b.com  ')).toBe(true);
  });
  it('rejects the shapes people actually mistype', () => {
    expect(isValidEmail('a@b')).toBe(false);       // no dot in the domain
    expect(isValidEmail('ab.com')).toBe(false);     // no @
    expect(isValidEmail('a b@c.com')).toBe(false);  // whitespace
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe('passwordProblem', () => {
  it('names the problem, or nothing when the password is fine', () => {
    expect(passwordProblem('')).toBe('required');
    expect(passwordProblem('short')).toBe('tooShort');
    expect(passwordProblem('x'.repeat(201))).toBe('tooLong');
    expect(passwordProblem('longenough')).toBeNull();
  });

  it('agrees with the server policy at every boundary', () => {
    // The whole reason this lives in a shared file: a browser rule that disagrees
    // with the API either blocks a valid password or promises one the server refuses.
    for (const pw of ['', 'x'.repeat(PASSWORD_MIN - 1), 'x'.repeat(PASSWORD_MIN), 'x'.repeat(200), 'x'.repeat(201)]) {
      expect(passwordProblem(pw) === null).toBe(passwordPolicyError(pw) === null);
    }
  });
});
