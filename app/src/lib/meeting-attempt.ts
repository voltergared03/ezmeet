/**
 * Was this meeting attempt actually held, or did someone open the room and leave?
 *
 * The bug this exists for: a meeting scheduled at 13:00, one invitee joins at 12:55 by
 * accident and leaves after 30 seconds. LiveKit's empty-room timeout then fires
 * room_finished, the meeting is marked ended exactly when it should be starting, and a
 * full AI report is generated — with its emails, notifications and ClickUp tasks — out
 * of thirty seconds of silence.
 *
 * WHY THIS READS NO ATTENDANCE DATA. The obvious rule ("fewer than two people joined")
 * is unimplementable on this schema: MeetingParticipant is an INVITE list, not a
 * presence log. Quick meetings create no participant rows at all; guests join with a
 * `guest-…` identity that matches no User row; and the join webhook only ever runs
 * updateMany with `joinedAt: null`, so it never creates a row and never re-stamps a
 * rejoin. Counting participants would classify every quick meeting and every call with
 * an external guest as abandoned and destroy their reports.
 *
 * So this is an EMPTINESS test with an affirmative floor, and the default is `held`.
 * Absence of a transcript is absence of evidence, never evidence of absence — a
 * meeting with transcription switched off produces zero segments by design.
 */

/** A session shorter than this, with nothing else to show for it, was not a meeting. */
export const SESSION_FLOOR_SEC = 120;
/** Roughly a couple of spoken sentences — enough that something was actually discussed. */
export const SPEECH_MIN_CHARS = 200;
/** Same floor as the session: a recording this short is the accident, not the meeting. */
export const RECORDING_MIN_SEC = 120;

export interface AttemptFacts {
  /** Human override — "it did happen". */
  heldConfirmedAt: Date | null;
  /** (endedAt ?? now) − startedAt. Null when startedAt was never stamped. */
  sessionSec: number | null;
  /** Total characters across this meeting's transcript segments. */
  spokenChars: number;
  /** Any per-speaker audio track was captured. */
  hasSpeakerTrack: boolean;
  /** A recording exists for this attempt. */
  hasRecording: boolean;
  /** Its duration, when known. */
  recordingSec: number | null;
}

export type Verdict = 'held' | 'abandoned';

/**
 * Pure — no I/O, so every branch is unit-testable. `abandoned` requires ALL of: a short
 * wall-clock session, no substantive speech, and no durable audio artifact. Anything
 * else, including anything unmeasurable, is `held`.
 */
export function classifyAttempt(f: AttemptFacts): { verdict: Verdict; reason: string } {
  if (f.heldConfirmedAt) return { verdict: 'held', reason: 'human-confirmed' };
  if (f.hasSpeakerTrack) return { verdict: 'held', reason: 'speaker-track' };
  if (f.hasRecording && (f.recordingSec == null || f.recordingSec >= RECORDING_MIN_SEC)) {
    return { verdict: 'held', reason: 'recording' };
  }
  if (f.spokenChars >= SPEECH_MIN_CHARS) return { verdict: 'held', reason: 'speech' };
  // No start stamp → we cannot measure it, so we must not judge it.
  if (f.sessionSec == null) return { verdict: 'held', reason: 'unmeasurable' };
  if (f.sessionSec >= SESSION_FLOOR_SEC) return { verdict: 'held', reason: 'duration' };
  return { verdict: 'abandoned', reason: 'short-and-empty' };
}
