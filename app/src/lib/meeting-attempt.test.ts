import { describe, it, expect } from 'vitest';
import { classifyAttempt, type AttemptFacts } from '@/lib/meeting-attempt';

const base: AttemptFacts = {
  heldConfirmedAt: null, sessionSec: 600, spokenChars: 5000,
  hasSpeakerTrack: true, hasRecording: true, recordingSec: 600,
};
const empty: AttemptFacts = {
  heldConfirmedAt: null, sessionSec: 30, spokenChars: 0,
  hasSpeakerTrack: false, hasRecording: false, recordingSec: null,
};

describe('classifyAttempt', () => {
  it('the reported bug: joined by accident, left after 30s, nothing captured → abandoned', () => {
    expect(classifyAttempt(empty).verdict).toBe('abandoned');
  });

  it('an ordinary meeting is held', () => {
    expect(classifyAttempt(base).verdict).toBe('held');
  });

  // Each of these is a real meeting the naive "count the participants" rule would have destroyed.
  it('holds a meeting with transcription OFF — zero segments is by design, not evidence of a no-show', () => {
    const v = classifyAttempt({ ...empty, sessionSec: 2700, spokenChars: 0 });
    expect(v.verdict).toBe('held');
    expect(v.reason).toBe('duration');
  });

  it('holds a short meeting where people actually spoke', () => {
    const v = classifyAttempt({ ...empty, sessionSec: 90, spokenChars: 400 });
    expect(v.verdict).toBe('held');
    expect(v.reason).toBe('speech');
  });

  it('holds when audio was captured even if the session looks short', () => {
    expect(classifyAttempt({ ...empty, hasSpeakerTrack: true }).reason).toBe('speaker-track');
    expect(classifyAttempt({ ...empty, hasRecording: true, recordingSec: 600 }).reason).toBe('recording');
  });

  it('a junk 40-second recording does NOT rescue an abandoned attempt', () => {
    expect(classifyAttempt({ ...empty, hasRecording: true, recordingSec: 40 }).verdict).toBe('abandoned');
  });

  it('a recording of unknown length counts as held — never guess against the user', () => {
    expect(classifyAttempt({ ...empty, hasRecording: true, recordingSec: null }).verdict).toBe('held');
  });

  it('never judges what it cannot measure: no startedAt → held', () => {
    const v = classifyAttempt({ ...empty, sessionSec: null });
    expect(v.verdict).toBe('held');
    expect(v.reason).toBe('unmeasurable');
  });

  it('a human saying "it happened" beats every automatic signal', () => {
    const v = classifyAttempt({ ...empty, heldConfirmedAt: new Date() });
    expect(v.verdict).toBe('held');
    expect(v.reason).toBe('human-confirmed');
  });

  it('exactly at the floors it is held — the floors are inclusive', () => {
    expect(classifyAttempt({ ...empty, sessionSec: 120 }).verdict).toBe('held');
    expect(classifyAttempt({ ...empty, spokenChars: 200 }).verdict).toBe('held');
  });
});
