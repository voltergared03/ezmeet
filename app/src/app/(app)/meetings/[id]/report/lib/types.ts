/* ─── Types ─────────────────────────────────────────────────────── */

export interface Participant {
  id: string;
  user: { id: string; name: string; email?: string | null; image: string | null } | null;
  guestName: string | null;
}

export interface SpeakerTrackItem {
  id: string;
  speakerId: string | null;
  participantIdentity: string;
  speakerName: string | null;
  durationSec: number | null;
  detectedLanguage: string | null;
}

export interface TranscriptSegment {
  id: string;
  speakerId?: string | null; // User.id when the speaker is a registered user; null for a guest
  speakerName: string;
  speakerUserName?: string | null; // registered account name (may differ from the spoken/STT label)
  speakerImage?: string | null;
  language: 'ua' | 'en' | 'ru';
  timestamp: string;
  startTime: number;
  text: string;
}

export interface ActionItem {
  id: string;
  text: string;
  assignee: string; // lead (first assignee) — kept for back-compat / PDF export
  assigneeImage?: string | null;
  assigneeRegistered?: boolean;
  // Full assignee set (виконавці). Registered members have an id; a guest lead
  // (no account) appears with id null.
  assignees: { id: string | null; name: string; image: string | null; registered: boolean }[];
  dueDate: string | null;
  priority: 'high' | 'medium' | 'low';
  // Canonical 3-state task status (mirrors the Tasks board); `done` is the
  // derived shortcut (status === 'done') kept for the checkbox/PDF/export.
  status: 'open' | 'in_progress' | 'done';
  done: boolean;
  // ClickUp / Linear two-way sync: read-only mirror when managed (status flows from the external tracker).
  clickupManaged?: boolean;
  clickupUrl?: string | null;
  linearManaged?: boolean;
  linearUrl?: string | null;
}

export interface UserItem {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

// A selectable assignee in the report dropdown: a registered user (id set) or a
// guest who joined the meeting by name (id null).
export interface AssignOption {
  id: string | null;
  name: string;
  email?: string;
  image?: string | null;
  guest?: boolean;
}

export interface Topic {
  title: string;
  discussion: string;
  decisions: { text: string; owner: string | null; cites: number[] }[];
  tasks: { title: string; assignee: string | null; priority: string; due: string | null; cites: number[] }[];
  openQuestions: { text: string; cites: number[] }[];
  cites: number[];
}

export interface Report {
  id: string;
  summary: string;
  actionItems: ActionItem[];
  decisions: string[];
  followUps: string[];
  topics: Topic[];
  analytics: {
    durationMin: number;
    wordsCount: number;
    repliesCount: number;
    languagesCount: number;
    languages: { label: string; code: string; pct: number; color: string }[];
    speakers: { name: string; image?: string | null; pct: number }[];
  };
  recording?: {
    fileName: string;
    fileSize: string;
    duration: string;
  } | null;
}

export interface Meeting {
  id: string;
  title: string;
  scheduledAt: string;
  createdAt: string;
  endedAt: string | null;
  durationMin: number;
  status: string;
  participants: Participant[];
  transcripts: TranscriptSegment[];
  reports: Report[];
}
