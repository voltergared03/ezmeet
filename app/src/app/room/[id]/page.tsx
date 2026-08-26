'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { Select } from '@/components/ui/select';
import { useSaveErrorToast } from '@/components/save-toast';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useDataChannel,
  useTracks,
  useParticipants,
  useLocalParticipant,
  useRoomContext,
  TrackRefContext,
  VideoTrack,
  AudioTrack,
  useChat,
  TrackLoop,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track, RoomEvent, ScreenSharePresets } from 'livekit-client';
import { Logo } from '@/components/ui/logo';
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff,
  Phone, MessageSquare, FileText, X, Languages,
  Send, MoreVertical, Users, UserPlus, Link2, Check,
  LogOut, Shield, Crown, Volume2, ChevronDown,
  Smile, StickyNote, Sparkles, Zap, Save, Sidebar, ListChecks,
} from 'lucide-react';
import {
  TranscriptEntry, FloatingReaction, LiveAiNote, DetectedActionItem, MeetingBriefing, REACTIONS,
} from './lib/types';
import { AdmissionPanel } from './components/AdmissionPanel';
import { ParticipantTile } from './components/ParticipantTile';
import { RoomDeviceSelect } from './components/RoomDeviceSelect';
import { ControlBtn, MoreItem } from './components/ControlBtn';
import { useIsMobile } from '@/lib/use-is-mobile';

/* ══════════════════════════════════════════════════════════
   ROOM CONTENT — rendered inside <LiveKitRoom>
   ══════════════════════════════════════════════════════════ */
function RoomContent({ meetingId, joinToken, isGuest, canKick, openTranscript, recordingActive, meetingInfo }: {
  meetingId: string; joinToken?: string; isGuest?: boolean; canKick?: boolean; openTranscript?: boolean; recordingActive?: boolean; meetingInfo?: MeetingBriefing;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const router = useRouter();

  /* ── sidebar state ─────────────────── */
  const [sidePanel, setSidePanel] = useState<'agenda' | 'chat' | 'transcript' | 'participants' | 'notes' | 'ai-notes' | null>(openTranscript ? 'transcript' : null);
  const [showMore, setShowMore] = useState(false);
  /* ── meeting briefing (description + agenda "питання") ── */
  const agendaItems = useMemo(
    () => (meetingInfo?.agenda ?? []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
    [meetingInfo],
  );
  const briefingDescription = meetingInfo?.description?.trim() || '';
  const hasBriefing = briefingDescription.length > 0 || agendaItems.length > 0;
  const isMobile = useIsMobile();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedCam, setSelectedCam] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [showSharePopup, setShowSharePopup] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [kickingId, setKickingId] = useState<string | null>(null);
  // A failed kick used to raise a modal dialog over a live call — it steals focus from
  // the video, and everyone else in the room keeps talking while you dismiss it.
  const { showSaveError, saveToast } = useSaveErrorToast();

  const shareLink = joinToken
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join/${joinToken}`
    : typeof window !== 'undefined' ? window.location.href : '';

  const copyShareLink = useCallback(() => {
    navigator.clipboard.writeText(shareLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [shareLink]);

  /* ── kick participant ──────────────── */
  const kickParticipant = useCallback(async (identity: string) => {
    if (!confirm(tr('room.kickConfirm'))) return;
    setKickingId(identity);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantIdentity: identity }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showSaveError(data.error || tr('room.kickFailed'));
      }
    } catch {
      showSaveError(tr('room.connectionError'));
    } finally {
      setKickingId(null);
    }
  }, [meetingId]);

  /* ── device management ────────────── */
  const enumerateDevices = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setDevices(devs);

      // Resolve the device actually in use for each kind; fall back to the
      // browser "default" entry (or the first available) so each select shows
      // a real device name instead of the "not found" placeholder.
      const resolve = (kind: MediaDeviceKind, fromTrack?: string) => {
        if (fromTrack && devs.some(d => d.kind === kind && d.deviceId === fromTrack)) return fromTrack;
        const list = devs.filter(d => d.kind === kind && d.deviceId);
        return (list.find(d => d.deviceId === 'default') || list[0])?.deviceId || '';
      };

      const micId = localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack?.getSettings()?.deviceId;
      const camId = localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack?.getSettings()?.deviceId;

      setSelectedMic(prev => prev || resolve('audioinput', micId));
      setSelectedCam(prev => prev || resolve('videoinput', camId));
      setSelectedSpeaker(prev => prev || resolve('audiooutput'));
    } catch (e) { console.error('Device enum error:', e); }
  }, [localParticipant]);

  const switchMic = useCallback(async (deviceId: string) => {
    setSelectedMic(deviceId);
    try {
      await room.switchActiveDevice('audioinput', deviceId);
    } catch (e) { console.error('Switch mic error:', e); }
  }, [room]);

  const switchCam = useCallback(async (deviceId: string) => {
    setSelectedCam(deviceId);
    try {
      await room.switchActiveDevice('videoinput', deviceId);
    } catch (e) { console.error('Switch cam error:', e); }
  }, [room]);

  const switchSpeaker = useCallback(async (deviceId: string) => {
    setSelectedSpeaker(deviceId);
    try {
      await room.switchActiveDevice('audiooutput', deviceId);
    } catch (e) { console.error('Switch speaker error:', e); }
  }, [room]);

  /* ── chat ───────────────────────────── */
  const { chatMessages, send: sendChat, isSending } = useChat();
  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatMessages]);

  const handleSendChat = () => {
    const txt = chatInput.trim();
    if (!txt) return;
    sendChat(txt);
    setChatInput('');
  };

  /* ── transcription ─────────────────── */
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const interimRef = useRef<Record<string, string>>({});

  const onTranscript = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'transcription') return;
      if (!msg.isFinal) {
        interimRef.current[msg.speaker] = msg.text;
        setTranscripts(p => [...p]);
        return;
      }
      delete interimRef.current[msg.speaker];
      setTranscripts(p => [...p, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        speaker: msg.speaker, text: msg.text,
        language: msg.language || 'uk',
        timestamp: msg.timestamp || Date.now() / 1000,
      }].slice(-200));
    } catch { /* skip */ }
  }, []);

  useDataChannel('transcription', onTranscript);

  useEffect(() => {
    if (transcriptScrollRef.current) transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
  }, [transcripts]);

  // Group consecutive same-speaker / same-language finals into one block so a
  // continuous turn reads as a paragraph (mirrors the server-side merge).
  const groupedTranscripts = useMemo(() => {
    const out: { id: string; speaker: string; language: string; text: string }[] = [];
    for (const e of transcripts) {
      const last = out[out.length - 1];
      if (last && last.speaker === e.speaker && last.language === e.language) {
        last.text += ' ' + e.text;
      } else {
        out.push({ id: e.id, speaker: e.speaker, language: e.language, text: e.text });
      }
    }
    return out;
  }, [transcripts]);

  /* ── recording (fully automatic — starts with the meeting; no manual toggle) ── */
  const [recording, setRecording] = useState(!!recordingActive);

  // Keep the REC indicator truthful if recording state is broadcast on the data channel.
  const onRecordingState = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'recording') return;
      setRecording(!!msg.active);
    } catch { /* skip */ }
  }, []);

  useDataChannel('recording', onRecordingState);

  /* ── reactions ─────────────────────── */
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  const onReaction = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'reaction') return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const x = 10 + Math.random() * 80;
      setFloatingReactions(prev => [...prev, { id, emoji: msg.emoji, sender: msg.sender, x }]);
      setTimeout(() => {
        setFloatingReactions(prev => prev.filter(r => r.id !== id));
      }, 3000);
    } catch { /* skip */ }
  }, []);

  useDataChannel('reactions', onReaction);

  const sendReaction = useCallback(async (emoji: string) => {
    try {
      await room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({
          type: 'reaction',
          emoji,
          sender: localParticipant.name || localParticipant.identity,
        })),
        { topic: 'reactions' },
      );
    } catch { /* skip */ }
    setShowReactionPicker(false);
  }, [room, localParticipant]);

  /* ── collaborative notes ──────────── */
  const [notesContent, setNotesContent] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesLastSaved, setNotesLastSaved] = useState<string | null>(null);
  const notesTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load notes on mount
  useEffect(() => {
    if (!meetingId) return;
    fetch(`/api/meetings/${meetingId}/notes`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setNotesContent(data.content || ''); })
      .catch(() => {});
  }, [meetingId]);

  // Broadcast note changes via data channel
  const onRemoteNotes = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'notes-update') return;
      setNotesContent(msg.content);
    } catch { /* skip */ }
  }, []);

  useDataChannel('notes', onRemoteNotes);

  const handleNotesChange = useCallback((value: string) => {
    setNotesContent(value);
    // Broadcast to others
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'notes-update', content: value })),
        { topic: 'notes' },
      );
    } catch { /* skip */ }
    // Auto-save with debounce
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(async () => {
      setNotesSaving(true);
      try {
        await fetch(`/api/meetings/${meetingId}/notes`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: value }),
        });
        setNotesLastSaved(new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));
      } catch { /* skip */ }
      setNotesSaving(false);
    }, 1500);
  }, [meetingId, room, localParticipant]);

  /* ── live AI notes ────────────────── */
  const [liveAiNotes, setLiveAiNotes] = useState<LiveAiNote | null>(null);

  const onAiNotes = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'ai-notes') return;
      setLiveAiNotes({
        summary: msg.summary || '',
        decisions: msg.decisions || [],
        actionItems: msg.action_items || [],
        updatedAt: Date.now(),
      });
    } catch { /* skip */ }
  }, []);

  useDataChannel('ai-notes', onAiNotes);

  /* ── live action item detection ───── */
  const [detectedActions, setDetectedActions] = useState<DetectedActionItem[]>([]);

  const onActionDetected = useCallback((raw: { payload: Uint8Array }) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(raw.payload));
      if (msg.type !== 'action-detected') return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setDetectedActions(prev => [...prev, {
        id, title: msg.title, assignee: msg.assignee || null,
        timestamp: Date.now(), dismissed: false,
      }]);
      // Auto-dismiss after 15 seconds
      setTimeout(() => {
        setDetectedActions(prev => prev.filter(a => a.id !== id));
      }, 15000);
    } catch { /* skip */ }
  }, []);

  useDataChannel('action-items', onActionDetected);

  const dismissAction = useCallback((id: string) => {
    setDetectedActions(prev => prev.filter(a => a.id !== id));
  }, []);

  /* ── tracks ────────────────────────── */
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const screenTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const visibleCameraTracks = cameraTracks.filter(t => {
    const identity = t.participant?.identity || '';
    return !identity.startsWith('agent-') && !identity.startsWith('AJ_');
  });

  /* ── local toggles ─────────────────── */
  const [micOn, setMicOn] = useState(!localParticipant.isMicrophoneEnabled ? false : true);
  const [camOn, setCamOn] = useState(!localParticipant.isCameraEnabled ? false : true);
  const [screenOn, setScreenOn] = useState(false);

  useEffect(() => {
    setMicOn(localParticipant.isMicrophoneEnabled ?? false);
    setCamOn(localParticipant.isCameraEnabled ?? false);
  }, [localParticipant.isMicrophoneEnabled, localParticipant.isCameraEnabled]);

  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(!micOn);
    setMicOn(!micOn);
  };
  const toggleCam = async () => {
    await localParticipant.setCameraEnabled(!camOn);
    setCamOn(!camOn);
  };
  // Screen share is tuned for TEXT (spreadsheets, dashboards, code), not motion.
  // Publish options are per-track, so none of this touches the camera.
  const toggleScreen = async () => {
    try {
      if (screenOn) {
        await localParticipant.setScreenShareEnabled(false);
        setScreenOn(false);
        return;
      }
      await localParticipant.setScreenShareEnabled(
        true,
        // Deliberately no `resolution` here: passing one defeats the SDK's Safari-17
        // guard (WebKit 263015 captures at a fraction of the real size) and pins
        // capture to 15fps.
        { contentHint: 'text' },
        {
          // Pinned, not cosmetic. For an SVC codec (vp9/av1) the SDK overwrites
          // contentHint with 'motion' at publish time, silently undoing the line
          // above — so a "better codec" here would make text worse, not better.
          videoCodec: 'vp8',
          // A ceiling, not a target: congestion control still backs off on weak
          // uplinks, so this only spends bits on transients (scroll, window switch)
          // — exactly when text smears. 15fps is deliberate: h1080fps30 costs 2x
          // uplink and CPU for the same bits-per-pixel.
          screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15, priority: 'medium' },
          // Layers are additive, not a split, so this buys the 1080p layer nothing —
          // it just trims the spare 540p/625kbps layer we never switch down to
          // (adaptiveStream and dynacast are both off).
          screenShareSimulcastLayers: [ScreenSharePresets.h360fps3],
        },
      );
      setScreenOn(true);
    } catch { /* user cancelled */ }
  };
  const [leaveChoice, setLeaveChoice] = useState(false);

  const exitRoom = () => {
    room.disconnect();
    if (isGuest) router.push('/');
    else if (meetingId === 'quick') router.push('/');
    else router.push(`/meetings/${meetingId}/report`);
  };

  // Leaving a room you are ALONE in is ambiguous — usually "back in a minute", not
  // "we're done". Ask, instead of guessing. Everyone else (guests, quick meetings, or
  // anyone leaving a room that still has people in it) keeps the old one-click exit.
  //
  // This is a convenience, not the safety net: closing the tab skips it entirely, which
  // is why the real protection is the server-side abandoned-attempt check.
  const leaveMeeting = () => {
    const alone = participants.filter((p) => !p.identity.startsWith('agent-')).length <= 1;
    if (alone && !isGuest && meetingId !== 'quick') { setLeaveChoice(true); return; }
    exitRoom();
  };

  const endMeetingForEveryone = async () => {
    // Records a human verdict that the meeting happened, so the report is produced even
    // though the session was short and quiet.
    await fetch(`/api/meetings/${meetingId}/end`, { method: 'POST' }).catch(() => {});
    exitRoom();
  };

  /* ── elapsed time ──────────────────── */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };

  /* ── human participants ──────────── */
  const humanParticipants = participants.filter(p => {
    const id = p.identity || '';
    return !id.startsWith('agent-') && !id.startsWith('AJ_');
  });
  const humanCount = humanParticipants.length;

  /* ── screen-share active? ──────────── */
  const hasScreenShare = screenTracks.length > 0;
  const mainScreen = screenTracks[0];

  /* ── grid columns calculation ─────── */
  const tileCount = visibleCameraTracks.length;
  const gridCols = tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : tileCount <= 9 ? 3 : 4;

  /* ── language flags ────────────────── */
  const langFlag: Record<string, string> = { uk: '🇺🇦', en: '🇬🇧', ru: '🇷🇺' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#111317' }}>
      <RoomAudioRenderer />
      {!isGuest && <AdmissionPanel meetingId={meetingId} />}

      {/* ── Floating Reactions ──────────── */}
      {floatingReactions.map(r => (
        <div key={r.id} style={{
          position: 'fixed', left: `${r.x}%`, bottom: 100, zIndex: 300,
          pointerEvents: 'none',
          animation: 'reactionFloat 3s ease-out forwards',
        }}>
          <div style={{ textAlign: 'center' }}>
            <span style={{ fontSize: 40 }}>{r.emoji}</span>
            <div style={{
              fontSize: 10, color: 'rgba(255,255,255,.7)',
              background: 'var(--overlay)', padding: '2px 8px',
              borderRadius: 6, marginTop: 2, whiteSpace: 'nowrap',
              backdropFilter: 'blur(4px)',
            }}>{r.sender}</div>
          </div>
        </div>
      ))}

      {/* ── Action Item Toasts ──────────── */}
      <div style={{
        position: 'fixed', top: 70, right: 20, zIndex: 250,
        display: 'flex', flexDirection: 'column', gap: 8,
        maxWidth: 340, pointerEvents: 'auto',
      }}>
        {detectedActions.map(action => (
          <div key={action.id} style={{
            display: 'flex', gap: 10, padding: '12px 14px',
            background: 'rgba(30, 32, 40, 0.95)', backdropFilter: 'blur(12px)',
            border: '1px solid rgba(167,139,250,.3)', borderRadius: 14,
            boxShadow: '0 8px 30px rgba(0,0,0,.4)',
            animation: 'fadeIn .2s ease',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: 'rgba(167,139,250,.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Zap size={16} style={{ color: 'var(--purple)' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--purple)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Action Item
              </div>
              <div style={{ fontSize: 13, color: 'var(--on-accent)', lineHeight: 1.4 }}>
                {action.title}
              </div>
              {action.assignee && (
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', marginTop: 3 }}>
                  → {action.assignee}
                </div>
              )}
            </div>
            <button onClick={() => dismissAction(action.id)} style={{
              background: 'none', border: 'none', color: 'rgba(255,255,255,.3)',
              cursor: 'pointer', padding: 2, flexShrink: 0, alignSelf: 'flex-start',
            }}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Share popup - fixed overlay */}
      {showSharePopup && (
        <div onClick={() => setShowSharePopup(false)} style={{
          position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '100%', maxWidth: 420, padding: '24px 22px',
            background: '#1e2028', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 16, boxShadow: '0 20px 60px var(--overlay)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--on-accent)' }}>{tr('room.inviteParticipants')}</div>
              <button onClick={() => setShowSharePopup(false)} style={{
                width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'var(--hover)', color: 'rgba(255,255,255,.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><X size={14} /></button>
            </div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,.5)', marginBottom: 16, lineHeight: 1.5 }}>
              {tr('room.inviteHint')}
            </div>
            <div style={{
              display: 'flex', gap: 8, alignItems: 'center',
              padding: '10px 14px', background: 'var(--hover)',
              borderRadius: 12, border: '1px solid var(--hover)', marginBottom: 12,
            }}>
              <Link2 size={15} style={{ color: 'rgba(255,255,255,.4)', flexShrink: 0 }} />
              <div style={{
                flex: 1, fontSize: 13, color: 'rgba(255,255,255,.7)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontFamily: 'var(--mono)',
              }}>{shareLink}</div>
            </div>
            <button onClick={() => { copyShareLink(); }} style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '12px 16px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: linkCopied ? '#22c55e' : 'var(--accent)', color: 'var(--on-accent)',
              fontSize: 14, fontWeight: 600, transition: 'background .15s',
            }}>
              {linkCopied ? <><Check size={15} /> {tr('room.linkCopied')}</> : <><Link2 size={15} /> {tr('room.copyLink')}</>}
            </button>
          </div>
        </div>
      )}

      {/* ── TOP BAR ──────────────────────── */}
      <div className="room-top-bar" style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        padding: '8px 16px', gap: 12,
        background: '#1a1d23', borderBottom: '1px solid var(--hover)',
      }}>
        <Logo />
        {recording && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500,
            background: 'rgba(239,68,68,.15)', color: 'var(--danger-fg)',
            border: '1px solid rgba(239,68,68,.3)',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)',
              animation: 'pulseDot 1.6s ease-in-out infinite', display: 'inline-block',
            }} />
            REC
          </span>
        )}
        <span className="room-timer" style={{ fontSize: 12, color: 'rgba(255,255,255,.45)', fontFamily: 'monospace' }}>
          {fmtTime(elapsed)}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,.5)' }}>
          <Users size={14} /> {humanCount}
        </div>
      </div>

      {/* ── MAIN AREA (video + sidebar) ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* ── Video area ─────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          <div style={{ flex: 1, padding: 8, display: 'flex', gap: 8, minHeight: 0, overflow: 'hidden' }}>
            {hasScreenShare ? (
              <div style={{ display: 'flex', flex: 1, gap: 8, minHeight: 0 }}>
                <div style={{
                  flex: 1, borderRadius: 12, overflow: 'hidden', background: '#000',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'relative', minWidth: 0,
                }}>
                  {mainScreen?.publication?.track && (
                    <VideoTrack trackRef={mainScreen}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  )}
                  <div style={{
                    position: 'absolute', bottom: 10, left: 12,
                    padding: '4px 10px', borderRadius: 6,
                    background: 'var(--overlay)', backdropFilter: 'blur(8px)',
                    fontSize: 12, color: 'var(--on-accent)',
                  }}>
                    📺 {mainScreen?.participant?.name || tr('room.screenShare')}
                  </div>
                </div>
                <div className="room-filmstrip" style={{
                  width: 180, display: 'flex', flexDirection: 'column', gap: 6,
                  overflowY: 'auto', flexShrink: 0,
                }}>
                  {visibleCameraTracks.map(track => (
                    <ParticipantTile key={track.participant.sid} track={track} small />
                  ))}
                </div>
              </div>
            ) : (
              <div className="room-video-grid" style={{
                flex: 1, display: 'grid',
                gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                gridAutoRows: tileCount <= 2 ? '1fr' : 'auto',
                gap: 10,
                alignContent: tileCount <= 2 ? 'stretch' : 'center',
                alignItems: 'center', maxHeight: '100%',
              }}>
                {visibleCameraTracks.map(track => (
                  <ParticipantTile key={track.participant.sid} track={track} fill={tileCount <= 2} />
                ))}
              </div>
            )}
          </div>

          {/* ── CONTROL BAR ──────────────── */}
          <div className="room-controls" style={{
            flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, padding: '10px 16px',
            background: '#1a1d23', borderTop: '1px solid var(--hover)',
          }}>
            <ControlBtn active={micOn} onClick={toggleMic} danger={!micOn}
              icon={micOn ? <Mic size={20} /> : <MicOff size={20} />} label={micOn ? tr('room.microphone') : tr('room.turnOn')} />
            <ControlBtn active={camOn} onClick={toggleCam} danger={!camOn}
              icon={camOn ? <Video size={20} /> : <VideoOff size={20} />} label={camOn ? tr('room.camera') : tr('room.turnOn')} />

            {/* Screen: inline on desktop; folded into the ⋮ More menu on mobile */}
            {!isMobile && (
              <ControlBtn active={screenOn} onClick={toggleScreen}
                icon={screenOn ? <MonitorOff size={20} /> : <Monitor size={20} />} label={tr('room.screen')} />
            )}

            {/* Reactions */}
            <div style={{ position: 'relative' }}>
              <ControlBtn active={showReactionPicker} onClick={() => setShowReactionPicker(!showReactionPicker)}
                icon={<Smile size={20} />} label={tr('room.reactions')} />
              {showReactionPicker && (
                <>
                  <div onClick={() => setShowReactionPicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 10px)', left: '50%', transform: 'translateX(-50%)',
                    padding: '8px 10px', zIndex: 100,
                    background: '#1e2028', border: '1px solid var(--hover-2)',
                    borderRadius: 14, boxShadow: '0 20px 50px var(--overlay)',
                    display: 'flex', gap: 4,
                  }}>
                    {REACTIONS.map(emoji => (
                      <button key={emoji} onClick={() => sendReaction(emoji)} style={{
                        width: 40, height: 40, borderRadius: 10, border: 'none',
                        background: 'var(--hover)', cursor: 'pointer',
                        fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all .12s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover-2)'; e.currentTarget.style.transform = 'scale(1.2)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.transform = 'scale(1)'; }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* ⋮ More — secondary actions (record / invite / devices; +screen, CC on mobile) */}
            <div style={{ position: 'relative' }}>
              <ControlBtn active={showMore} onClick={() => { if (!showMore) enumerateDevices(); setShowMore(!showMore); }}
                icon={<MoreVertical size={20} />} label={tr('room.more')} />
              {showMore && (
                <>
                  <div onClick={() => setShowMore(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 10px)', left: '50%', transform: 'translateX(-50%)',
                    width: 264, maxWidth: 'calc(100vw - 24px)', maxHeight: '68vh', overflowY: 'auto',
                    padding: 8, zIndex: 100,
                    background: '#1e2028', border: '1px solid var(--hover-2)',
                    borderRadius: 14, boxShadow: '0 20px 50px var(--overlay)',
                    display: 'flex', flexDirection: 'column', gap: 2,
                  }}>
                    {isMobile && (
                      <MoreItem icon={screenOn ? <MonitorOff size={17} /> : <Monitor size={17} />} active={screenOn}
                        label={tr('room.screen')} onClick={() => { toggleScreen(); setShowMore(false); }} />
                    )}
                    {/* Recording is fully automatic (starts with the meeting) — no manual
                        toggle. The REC indicator stays for transparency. */}
                    {!isGuest && (
                      <MoreItem icon={<UserPlus size={17} />}
                        label={tr('room.invite')} onClick={() => { setShowSharePopup(true); setShowMore(false); }} />
                    )}
                    <div style={{ height: 1, background: 'var(--hover)', margin: '6px 4px' }} />
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.4)', padding: '2px 8px 6px' }}>{tr('room.devices')}</div>
                    <RoomDeviceSelect label={tr('room.microphone')} icon={<Mic size={13} />}
                      devices={devices.filter(d => d.kind === 'audioinput')}
                      value={selectedMic} onChange={switchMic} />
                    <RoomDeviceSelect label={tr('room.camera')} icon={<Video size={13} />}
                      devices={devices.filter(d => d.kind === 'videoinput')}
                      value={selectedCam} onChange={switchCam} />
                    <RoomDeviceSelect label={tr('room.speakers')} icon={<Volume2 size={13} />}
                      devices={devices.filter(d => d.kind === 'audiooutput')}
                      value={selectedSpeaker} onChange={switchSpeaker} />
                  </div>
                </>
              )}
            </div>

            <div className="room-controls-divider" style={{ width: 1, height: 28, background: 'rgba(255,255,255,.1)', margin: '0 2px' }} />

            {/* Panel — participants / chat / transcript / notes / AI in one tabbed surface */}
            <ControlBtn active={!!sidePanel}
              onClick={() => setSidePanel(sidePanel ? null : 'participants')}
              icon={<Sidebar size={20} />} label={tr('room.panel')}
              badge={humanCount > 1 ? humanCount : undefined} />

            <div className="room-controls-divider" style={{ width: 1, height: 28, background: 'rgba(255,255,255,.1)', margin: '0 2px' }} />

            <button className="room-leave-btn" onClick={leaveMeeting} title={tr('room.leave')} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 20px', borderRadius: 24, cursor: 'pointer',
              background: 'var(--danger)', color: 'var(--on-accent)', border: 'none',
              fontSize: 14, fontWeight: 600, transition: 'background .15s', flexShrink: 0,
            }}>
              <Phone size={18} style={{ transform: 'rotate(135deg)' }} />
              <span className="room-leave-label">{tr('room.leave')}</span>
            </button>
          </div>
        </div>

        {/* ── SIDE PANEL ─────────────────── */}
        {sidePanel && (
          <div className="room-side-panel" style={{
            width: 400, flexShrink: 0, display: 'flex', flexDirection: 'column',
            background: '#1a1d23', borderLeft: '1px solid var(--hover)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'stretch',
              borderBottom: '1px solid var(--hover)', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', flex: 1, minWidth: 0, overflowX: 'hidden' }}>
                {([
                  ...(hasBriefing ? [{ id: 'agenda' as const, label: tr('room.agenda'), icon: <ListChecks size={16} />, badge: agendaItems.length }] : []),
                  { id: 'participants', label: tr('room.participants'), icon: <Users size={16} />, badge: humanCount > 1 ? humanCount : 0 },
                  { id: 'chat', label: tr('room.chat'), icon: <MessageSquare size={16} />, badge: chatMessages.length },
                  { id: 'transcript', label: tr('room.text'), icon: <FileText size={16} />, badge: 0 },
                  { id: 'notes', label: tr('room.notes'), icon: <StickyNote size={16} />, badge: 0 },
                  { id: 'ai-notes', label: tr('room.ai'), icon: <Sparkles size={16} />, badge: 0 },
                ] as const).map((tab) => {
                  const on = sidePanel === tab.id;
                  return (
                    <button key={tab.id} onClick={() => setSidePanel(tab.id)} title={tab.label} style={{
                      position: 'relative', flex: '1 1 0', minWidth: 0,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '10px 6px', cursor: 'pointer', background: 'none', border: 'none',
                      borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
                      color: on ? '#fff' : 'rgba(255,255,255,.5)', transition: 'color .15s',
                    }}>
                      {tab.icon}
                      <span style={{ fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.label}</span>
                      {tab.badge > 0 && (
                        <span style={{
                          position: 'absolute', top: 4, right: 6,
                          minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8,
                          background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 9, fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>{tab.badge > 9 ? '9+' : tab.badge}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <button onClick={() => setSidePanel(null)} aria-label="Close" style={{
                flexShrink: 0, background: 'none', border: 'none', color: 'rgba(255,255,255,.4)',
                cursor: 'pointer', padding: '0 14px', display: 'flex', alignItems: 'center',
                borderLeft: '1px solid var(--hover)',
              }}><X size={16} /></button>
            </div>

            {/* ── Agenda panel (meeting briefing: description + питання) ── */}
            {sidePanel === 'agenda' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
                {meetingInfo?.title && (
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--on-accent)', lineHeight: 1.35, letterSpacing: '-0.01em' }}>
                    {meetingInfo.title}
                  </div>
                )}
                {briefingDescription && (
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'rgba(255,255,255,.4)', marginBottom: 7 }}>
                      {tr('meetingForm.description')}
                    </div>
                    <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,.8)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {briefingDescription}
                    </div>
                  </div>
                )}
                {agendaItems.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'rgba(255,255,255,.4)', marginBottom: 10 }}>
                      <ListChecks size={13} /> {tr('schedule.agendaHeading')}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {agendaItems.map((item, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <span style={{
                            flexShrink: 0, width: 22, height: 22, borderRadius: 6,
                            background: 'rgba(59,130,246,.15)', color: '#93c5fd',
                            fontSize: 11, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
                          }}>{idx + 1}</span>
                          <span style={{ fontSize: 13.5, color: 'rgba(255,255,255,.85)', lineHeight: 1.5 }}>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Participants panel ── */}
            {sidePanel === 'participants' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0', minHeight: 0 }}>
                {humanParticipants.map(p => {
                  const isLocal = p.isLocal;
                  const identity = p.identity || '';
                  const isGuestUser = identity.startsWith('guest-');
                  const isMicEnabled = p.isMicrophoneEnabled;
                  const isCamEnabled = p.isCameraEnabled;

                  return (
                    <div key={p.sid} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 16px',
                      transition: 'background .1s',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Avatar */}
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%',
                        background: isGuestUser ? '#6366f1' : 'var(--accent)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 15, fontWeight: 700, color: 'var(--on-accent)', flexShrink: 0,
                      }}>
                        {(p.name || identity || 'U')[0]?.toUpperCase()}
                      </div>

                      {/* Name + badge */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          fontSize: 13, fontWeight: 600, color: 'var(--on-accent)',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.name || identity}
                          </span>
                          {isLocal && (
                            <span style={{
                              fontSize: 10, padding: '1px 5px', borderRadius: 4,
                              background: 'rgba(59,130,246,.2)', color: '#93c5fd',
                            }}>{tr('room.you')}</span>
                          )}
                          {isGuestUser && (
                            <span style={{
                              fontSize: 10, padding: '1px 5px', borderRadius: 4,
                              background: 'rgba(99,102,241,.2)', color: '#a5b4fc',
                            }}>{tr('room.guest')}</span>
                          )}
                        </div>
                        {/* Media status */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                          {isMicEnabled ? (
                            <Mic size={11} style={{ color: 'rgba(255,255,255,.35)' }} />
                          ) : (
                            <MicOff size={11} style={{ color: 'var(--danger-fg)' }} />
                          )}
                          {isCamEnabled ? (
                            <Video size={11} style={{ color: 'rgba(255,255,255,.35)' }} />
                          ) : (
                            <VideoOff size={11} style={{ color: 'var(--danger-fg)' }} />
                          )}
                        </div>
                      </div>

                      {/* Kick button — only for admin/host, not for self */}
                      {canKick && !isLocal && (
                        <button
                          onClick={() => kickParticipant(identity)}
                          disabled={kickingId === identity}
                          title={tr('room.removeFromMeeting')}
                          style={{
                            width: 32, height: 32, borderRadius: 8,
                            border: '1px solid rgba(239,68,68,.2)',
                            background: kickingId === identity ? 'rgba(239,68,68,.2)' : 'transparent',
                            color: 'var(--danger-fg)', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all .15s', flexShrink: 0,
                            opacity: kickingId === identity ? 0.5 : 1,
                          }}
                          onMouseEnter={e => { if (kickingId !== identity) e.currentTarget.style.background = 'rgba(239,68,68,.15)'; }}
                          onMouseLeave={e => { if (kickingId !== identity) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <LogOut size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}

                {humanCount === 0 && (
                  <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.25)', fontSize: 13, marginTop: 40 }}>
                    <Users size={28} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <div>{tr('room.noParticipants')}</div>
                  </div>
                )}

                {canKick && humanCount > 1 && (
                  <div style={{
                    margin: '16px 16px 0', padding: '10px 12px',
                    background: 'rgba(255,255,255,.03)',
                    borderRadius: 10, border: '1px solid var(--hover)',
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 11.5, color: 'rgba(255,255,255,.35)',
                  }}>
                    <Shield size={13} style={{ flexShrink: 0 }} />
                    <span>{tr('room.canRemoveParticipants')}</span>
                  </div>
                )}
              </div>
            )}

            {/* ── Chat panel ── */}
            {sidePanel === 'chat' && (
              <>
                <div ref={chatScrollRef} style={{
                  flex: 1, overflowY: 'auto', padding: '12px 14px',
                  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
                }}>
                  {chatMessages.length === 0 && (
                    <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.25)', fontSize: 13, marginTop: 40 }}>
                      <MessageSquare size={28} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                      <div>{tr('room.noMessages')}</div>
                    </div>
                  )}
                  {chatMessages.map((m, i) => (
                    <div key={i}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-2)' }}>
                          {m.from?.name || m.from?.identity || tr('room.you')}
                        </span>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,.25)' }}>
                          {new Date(m.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: 'rgba(255,255,255,.8)', lineHeight: 1.45 }}>{m.message}</div>
                    </div>
                  ))}
                </div>
                <div style={{
                  flexShrink: 0, padding: '10px 12px',
                  borderTop: '1px solid var(--hover)',
                  display: 'flex', gap: 8,
                }}>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                    placeholder={tr('room.messagePlaceholder')}
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 8,
                      background: 'var(--hover)', border: '1px solid rgba(255,255,255,.1)',
                      color: 'var(--on-accent)', fontSize: 13, outline: 'none',
                    }} />
                  <button onClick={handleSendChat} disabled={isSending || !chatInput.trim()} style={{
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                    background: chatInput.trim() ? 'var(--accent)' : 'var(--hover)',
                    color: 'var(--on-accent)', border: 'none', display: 'flex', alignItems: 'center',
                    opacity: chatInput.trim() ? 1 : 0.4,
                  }}><Send size={16} /></button>
                </div>
              </>
            )}

            {/* ── Transcript panel ── */}
            {sidePanel === 'transcript' && (
              <div ref={transcriptScrollRef} style={{
                flex: 1, overflowY: 'auto', padding: '12px 14px',
                display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0,
              }}>
                {transcripts.length === 0 && Object.keys(interimRef.current).length === 0 && (
                  <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.25)', fontSize: 13, marginTop: 40, lineHeight: 1.6 }}>
                    <Languages size={28} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <div>{tr('room.transcriptEmptyLine1')}</div>
                    <div>{tr('room.transcriptEmptyLine2')}</div>
                  </div>
                )}
                {groupedTranscripts.map(e => (
                  <div key={e.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{e.speaker}</span>
                      <span style={{ fontSize: 10, opacity: 0.5 }}>{langFlag[e.language] || '🌐'}</span>
                    </div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,.7)', lineHeight: 1.5 }}>{e.text}</div>
                  </div>
                ))}
                {Object.entries(interimRef.current).map(([speaker, text]) => (
                  <div key={`int-${speaker}`} style={{ opacity: 0.45 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{speaker} <span style={{ fontSize: 9, color: '#93c5fd' }}>...</span></div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,.5)', fontStyle: 'italic', lineHeight: 1.5 }}>{text}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Notes panel ── */}
            {sidePanel === 'notes' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{
                  flexShrink: 0, padding: '8px 14px',
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderBottom: '1px solid var(--hover)',
                  fontSize: 11, color: 'rgba(255,255,255,.35)',
                }}>
                  {notesSaving ? (
                    <><Save size={11} style={{ animation: 'spin .8s linear infinite' }} /> {tr('common.saving')}</>
                  ) : notesLastSaved ? (
                    <><Check size={11} /> {tr('room.savedAt', { time: notesLastSaved })}</>
                  ) : (
                    <><StickyNote size={11} /> {tr('room.sharedNotesHint')}</>
                  )}
                </div>
                <textarea
                  value={notesContent}
                  onChange={e => handleNotesChange(e.target.value)}
                  placeholder={tr('room.notesPlaceholder')}
                  style={{
                    flex: 1, resize: 'none', border: 'none', outline: 'none',
                    padding: '14px 14px', fontSize: 13, lineHeight: 1.6,
                    background: 'transparent', color: 'rgba(255,255,255,.85)',
                    fontFamily: 'inherit', minHeight: 0,
                  }}
                />
              </div>
            )}

            {/* ── AI Notes panel ── */}
            {sidePanel === 'ai-notes' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '14px', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {!liveAiNotes ? (
                  <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.25)', fontSize: 13, marginTop: 40, lineHeight: 1.6 }}>
                    <Sparkles size={28} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <div>{tr('room.aiEmptyLine1')}</div>
                    <div>{tr('room.aiEmptyLine2')}</div>
                    <div style={{ fontSize: 11, marginTop: 12, color: 'rgba(255,255,255,.15)' }}>
                      {tr('room.aiUpdatesAuto')}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Summary */}
                    {liveAiNotes.summary && (
                      <div>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: 'var(--accent-2)',
                          textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}>
                          <Sparkles size={11} /> {tr('room.summary')}
                        </div>
                        <div style={{
                          fontSize: 13, color: 'rgba(255,255,255,.75)', lineHeight: 1.6,
                          padding: '10px 12px', background: 'rgba(59,130,246,.06)',
                          borderRadius: 10, border: '1px solid rgba(59,130,246,.1)',
                        }}>
                          {liveAiNotes.summary}
                        </div>
                      </div>
                    )}

                    {/* Decisions */}
                    {liveAiNotes.decisions.length > 0 && (
                      <div>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: 'var(--success)',
                          textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}>
                          <Check size={11} /> {tr('room.decisions')}
                        </div>
                        {liveAiNotes.decisions.map((d, i) => (
                          <div key={i} style={{
                            fontSize: 13, color: 'rgba(255,255,255,.7)', lineHeight: 1.5,
                            padding: '6px 10px', marginBottom: 4,
                            borderLeft: '2px solid rgba(16,185,129,.4)',
                            paddingLeft: 10,
                          }}>
                            {d}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Action Items */}
                    {liveAiNotes.actionItems.length > 0 && (
                      <div>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: 'var(--purple)',
                          textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}>
                          <Zap size={11} /> Action Items
                        </div>
                        {liveAiNotes.actionItems.map((a, i) => (
                          <div key={i} style={{
                            fontSize: 13, color: 'rgba(255,255,255,.7)', lineHeight: 1.5,
                            padding: '6px 10px', marginBottom: 4,
                            borderLeft: '2px solid rgba(167,139,250,.4)',
                            paddingLeft: 10,
                          }}>
                            {a}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Updated timestamp */}
                    <div style={{
                      fontSize: 10, color: 'rgba(255,255,255,.2)', textAlign: 'center',
                      marginTop: 8,
                    }}>
                      {tr('room.updatedAt', { time: new Date(liveAiNotes.updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulseDot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes reactionFloat {
          0% { opacity: 1; transform: translateY(0) scale(1); }
          50% { opacity: 1; transform: translateY(-120px) scale(1.15); }
          100% { opacity: 0; transform: translateY(-240px) scale(0.8); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 768px) {
          .room-controls { gap: 4px !important; padding: 8px 8px !important; }
          .room-controls-divider { display: none !important; }
          .room-leave-btn { padding: 10px 14px !important; }
          .room-leave-label { display: none !important; }
          .room-side-panel { position: fixed !important; inset: 0 !important; width: 100% !important; z-index: 100; }
          .room-filmstrip { width: 120px !important; }
          .room-top-bar { padding: 6px 10px !important; gap: 8px !important; }
          .room-screen-btn { display: none !important; }
          .room-video-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 480px) {
          .room-controls { gap: 2px !important; padding: 6px 4px !important; }
        }
      `}</style>

      {/* Leaving a room you are alone in: "stepping out" and "we're done" look identical
          to the server, so ask rather than guess. Declining just leaves — the meeting
          stays open for whoever arrives next. */}
      {leaveChoice && (
        <div
          onClick={() => setLeaveChoice(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(6,8,12,.62)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ width: 'min(420px, 100%)', background: 'var(--card, #16181d)', border: '1px solid var(--hover-2)', borderRadius: 14, padding: '20px 22px', color: '#e8e8ea', boxShadow: '0 24px 70px -20px rgba(0,0,0,.75)' }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{tr('room.leaveTitle')}</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: '#a9a9b4', marginBottom: 18 }}>{tr('room.leaveBody')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-primary" onClick={exitRoom} style={{ width: '100%', fontWeight: 600 }}>
                {tr('room.leaveOnly')}
              </button>
              <button className="btn" onClick={() => void endMeetingForEveryone()} style={{ width: '100%' }}>
                {tr('room.endForAll')}
              </button>
              <button className="btn btn-ghost" onClick={() => setLeaveChoice(false)} style={{ width: '100%', color: 'var(--muted)' }}>
                {tr('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      {saveToast}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════ */
export default function MeetingRoomPage() {
  const t = useTranslations();
  const { id } = useParams();
  const searchParams = useSearchParams();
  const startWithVideo = searchParams.get('cam') !== '0';
  const startWithAudio = searchParams.get('mic') !== '0';
  const startWithTranscript = searchParams.get('tx') === '1';
  const guestName = searchParams.get('guest') || '';
  const micDeviceId = searchParams.get('micId') || '';
  const camDeviceId = searchParams.get('camId') || '';
  const spkDeviceId = searchParams.get('spkId') || '';
  const startNow = searchParams.get('start') === '1'; // host explicitly starting before the 5-min window
  const router = useRouter();
  const [token, setToken] = useState('');
  const [wsUrl, setWsUrl] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [meetingIdReal, setMeetingIdReal] = useState('');
  const [canKick, setCanKick] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [meetingInfo, setMeetingInfo] = useState<MeetingBriefing>({ title: null, description: null, agenda: null });
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const guest = guestName;
    let cancelled = false;
    let reqId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchToken() {
      try {
        const body: any = {};
        if (guest) { body.guestName = guest; if (reqId) body.requestId = reqId; }
        if (startNow) body.startNow = true; // host starting before the 5-min entry window

        const res = await fetch(`/api/meetings/${id}/join-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // 202 = waiting room: guest pending host approval
        if (res.status === 202) {
          const data = await res.json().catch(() => ({}));
          reqId = data.requestId;
          if (!cancelled) { setWaiting(true); timer = setTimeout(fetchToken, 3000); }
          return;
        }
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          // 410 = this occurrence ended/cancelled. If the series has a live
          // successor, bounce straight there so the user lands with everyone
          // else instead of hitting a dead room.
          if (res.status === 410 && errData.nextToken) {
            if (!cancelled) router.replace(`/join/${errData.nextToken}`);
            return;
          }
          throw new Error(errData.denied ? t('room.accessDenied') : (errData.error || t('room.tokenFailed')));
        }
        const data = await res.json();
        if (cancelled) return;
        setWaiting(false);
        setToken(data.token);
        setWsUrl(data.wsUrl);
        if (data.joinToken) setJoinToken(data.joinToken);
        if (data.meetingId) {
          setMeetingIdReal(data.meetingId);
          // Quick meetings live at /room/quick; once the real meeting exists,
          // rewrite the address bar to its id so a copied URL is shareable.
          // history.replaceState (not router) keeps it cosmetic — no refetch.
          if (id === 'quick' && typeof window !== 'undefined') {
            window.history.replaceState(null, '', `/room/${data.meetingId}${window.location.search}`);
          }
        }
        if (data.canKick) setCanKick(true);
        if (typeof data.recordingActive === 'boolean') setRecordingActive(data.recordingActive);
        setMeetingInfo({
          title: typeof data.title === 'string' ? data.title : null,
          description: typeof data.description === 'string' ? data.description : null,
          agenda: Array.isArray(data.agenda) ? data.agenda.filter((x: unknown) => typeof x === 'string' && x.trim()) : null,
        });
      } catch (e: any) {
        console.error('Join token error:', e);
        if (!cancelled) setError(e.message);
      }
    }
    fetchToken();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id, guestName]);

  if (error) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#111317', color: 'var(--on-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{t('room.error')}</div>
          <div style={{ color: '#999', marginBottom: 16, maxWidth: 360 }}>{error}</div>
          <button onClick={() => router.push('/')} style={{
            padding: '10px 20px', borderRadius: 10, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer',
          }}>{t('room.goHome')}</button>
        </div>
      </div>
    );
  }

  if (waiting && !token) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#111317', color: 'var(--on-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 380 }}>
          <div style={{
            width: 40, height: 40, border: '3px solid rgba(255,255,255,.15)',
            borderTop: '3px solid var(--accent)', borderRadius: '50%',
            animation: 'spin .8s linear infinite', margin: '0 auto 18px',
          }} />
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{t('room.waitingTitle')}</div>
          <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 14, lineHeight: 1.5 }}>{t('room.waitingDesc')}</div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!token || !wsUrl) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#111317', color: 'var(--on-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32, border: '3px solid rgba(255,255,255,.15)',
            borderTop: '3px solid var(--accent)', borderRadius: '50%',
            animation: 'spin .8s linear infinite',
          }} />
          <span style={{ fontSize: 15, color: 'rgba(255,255,255,.6)' }}>{t('room.connecting')}</span>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111317' }}>
      <LiveKitRoom
        serverUrl={wsUrl}
        token={token}
        connect={true}
        video={startWithVideo}
        audio={startWithAudio}
        options={{
          audioCaptureDefaults: micDeviceId ? { deviceId: micDeviceId } : undefined,
          videoCaptureDefaults: camDeviceId ? { deviceId: camDeviceId } : undefined,
          audioOutput: spkDeviceId ? { deviceId: spkDeviceId } : undefined,
        }}
        onDisconnected={() => {
          if (guestName) router.push('/');
          else if (id === 'quick') router.push('/');
          else router.push(`/meetings/${id}/report`);
        }}
        style={{ height: '100%' }}
      >
        <RoomContent meetingId={meetingIdReal || id as string} joinToken={joinToken} isGuest={!!guestName} canKick={canKick} openTranscript={startWithTranscript} recordingActive={recordingActive} meetingInfo={meetingInfo} />
      </LiveKitRoom>
    </div>
  );
}
