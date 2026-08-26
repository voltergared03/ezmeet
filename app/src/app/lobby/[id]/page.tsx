'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { Select } from '@/components/ui/select';
import { useSession } from 'next-auth/react';
import { Logo } from '@/components/ui/logo';
import { AvatarStack } from '@/components/ui/avatar';
import {
  Mic, MicOff, Video, VideoOff, Settings,
  X, Users, Clock, Lock, ChevronDown, Volume2, Speaker, ListChecks,
} from 'lucide-react';
import { fmtRelative, fmtTime } from '@/lib/utils';

export default function LobbyPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const guestName = searchParams.get('guest') || '';
  const { data: session } = useSession();
  const [meeting, setMeeting] = useState<any>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [txPref, setTxPref] = useState(false); // open transcript panel on join (user pref)
  const [name, setName] = useState('');
  const [showDevices, setShowDevices] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedCam, setSelectedCam] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');

  const appliedPrefs = useRef(false);

  useEffect(() => {
    if (guestName) setName(guestName);
    else if (session?.user?.name) setName(session.user.name);
  }, [session?.user?.name]);

  // Apply the user's "join with mic/cam on" preferences (registered users only;
  // guests keep mic/cam on by default). Runs once when the session is available.
  useEffect(() => {
    if (appliedPrefs.current || !session?.user) return;
    appliedPrefs.current = true;
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.preferences) {
          setMic(!!d.preferences.micOnJoin);
          setCam(!!d.preferences.camOnJoin);
          setTxPref(!!d.preferences.liveTranscript);
        }
      })
      .catch(() => {});
  }, [session?.user]);

  const enumerateDevices = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());
      const devs = await navigator.mediaDevices.enumerateDevices();
      setDevices(devs);
      if (!selectedMic) {
        const mic = devs.find(d => d.kind === 'audioinput');
        if (mic) setSelectedMic(mic.deviceId);
      }
      if (!selectedCam) {
        const cam = devs.find(d => d.kind === 'videoinput');
        if (cam) setSelectedCam(cam.deviceId);
      }
      if (!selectedSpeaker) {
        const spk = devs.find(d => d.kind === 'audiooutput');
        if (spk) setSelectedSpeaker(spk.deviceId);
      }
    } catch (e) { console.error('Device enumeration error:', e); }
  }, [selectedMic, selectedCam, selectedSpeaker]);

  useEffect(() => { enumerateDevices(); }, []);

  useEffect(() => {
    if (id === 'quick') return;
    fetch(`/api/meetings/${id}`)
      .then((r) => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then((m: any) => setMeeting(m))
      .catch(console.error);
  }, [id]);

  // Re-evaluate the "too early" gate on a timer so the join button unlocks once the
  // 5-minutes-before window opens, without a manual refresh.
  useEffect(() => {
    const i = setInterval(() => setNowTs(Date.now()), 20000);
    return () => clearInterval(i);
  }, []);

  const joinMeeting = (startNow = false) => {
    const params = new URLSearchParams();
    if (!mic) params.set('mic', '0');
    if (!cam) params.set('cam', '0');
    if (!session?.user && name) params.set('guest', name);
    if (selectedMic) params.set('micId', selectedMic);
    if (selectedCam) params.set('camId', selectedCam);
    if (selectedSpeaker) params.set('spkId', selectedSpeaker);
    if (txPref) params.set('tx', '1');
    if (startNow) params.set('start', '1');
    const qs = params.toString();
    router.push(`/room/${id}${qs ? '?' + qs : ''}`);
  };

  // Entry gate (mirrors the server check in join-token): a still-scheduled meeting
  // opens 5 min before its start; earlier, only the host/admin sees "Start now".
  const uid = session?.user?.id;
  const role = session?.user?.role;
  const isHost = !!uid && (meeting?.createdById === uid || role === 'admin');
  const schedMs = meeting?.scheduledAt ? new Date(meeting.scheduledAt).getTime() : null;
  const tooEarly = schedMs != null && meeting?.status === 'scheduled' && nowTs < schedMs - 5 * 60_000;

  const getParticipantNames = (m: any) =>
    (m.participants || []).map((p: any) => ({
      name: p.user?.name || p.guestName || 'Guest',
      image: p.user?.image || null,
    }));

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'radial-gradient(circle at 30% 20%, color-mix(in oklab, var(--accent) 10%, var(--bg)) 0%, var(--bg) 70%)',
      display: 'flex', flexDirection: 'column', overflow: 'auto',
    }}>
      <div className='lobby-header' style={{ padding: '18px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Logo />
        <button className="btn btn-ghost" onClick={() => router.push('/')}>
          <X size={15} /> {t('lobby.leave')}
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div className='lobby-grid' style={{
          display: 'grid', gap: 32,
          maxWidth: 1100, width: '100%', alignItems: 'center',
        }}>
          {/* Video preview */}
          <div>
            <MediaPreview
              mic={mic}
              cam={cam}
              userName={name || session?.user?.name || 'U'}
              userInitial={session?.user?.name?.[0] || 'U'}
              selectedMic={selectedMic}
              selectedCam={selectedCam}
            />

            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 18 }}>
              <LobbyControlBtn active={mic} onClick={() => setMic(!mic)}
                icon={mic ? <Mic size={20} /> : <MicOff size={20} />} />
              <LobbyControlBtn active={cam} onClick={() => setCam(!cam)}
                icon={cam ? <Video size={20} /> : <VideoOff size={20} />} />
              <div style={{ position: 'relative' }}>
                <button className="btn" onClick={() => { enumerateDevices(); setShowDevices(!showDevices); }}
                  style={{ padding: '12px 14px', borderRadius: 12, background: showDevices ? 'var(--surface-3)' : undefined }}>
                  <Settings size={15} /> {t('lobby.devices')} <ChevronDown size={13} style={{ transform: showDevices ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                </button>
                {showDevices && (
                  <>
                    <div onClick={() => setShowDevices(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                    <div style={{
                      position: 'absolute', bottom: 'calc(100% + 10px)', left: '50%', transform: 'translateX(-50%)',
                      width: 320, maxWidth: 'calc(100vw - 24px)', padding: '14px 16px', zIndex: 100,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 14, boxShadow: '0 20px 50px var(--overlay)',
                    }}>
                      <DeviceSelect label={t('lobby.microphone')} icon={<Mic size={14} />}
                        devices={devices.filter(d => d.kind === 'audioinput')}
                        value={selectedMic} onChange={setSelectedMic} />
                      <DeviceSelect label={t('lobby.camera')} icon={<Video size={14} />}
                        devices={devices.filter(d => d.kind === 'videoinput')}
                        value={selectedCam} onChange={setSelectedCam} />
                      <DeviceSelect label={t('lobby.speakers')} icon={<Volume2 size={14} />}
                        devices={devices.filter(d => d.kind === 'audiooutput')}
                        value={selectedSpeaker} onChange={setSelectedSpeaker} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right: meeting info + join */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {meeting ? (
              <>
                <div>
                  {meeting.scheduledAt && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                      {fmtRelative(new Date(meeting.scheduledAt), locale)} &bull; {fmtTime(new Date(meeting.scheduledAt))}
                    </div>
                  )}
                  <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 10px', letterSpacing: '-0.02em' }}>
                    {meeting.title}
                  </h1>
                  {meeting.description && (
                    <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55, margin: '0 0 12px' }}>
                      {meeting.description}
                    </p>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--muted)' }}>
                    <Users size={13} /> {t('lobby.invitedCount', { count: meeting.participants?.length || 0 })}
                    <span>&bull;</span>
                    <Clock size={13} /> {t('common.minutes', { count: meeting.durationMin })}
                  </div>
                </div>

                {Array.isArray(meeting.agenda) && meeting.agenda.filter((x: unknown) => typeof x === 'string' && x.trim()).length > 0 && (
                  <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
                      <ListChecks size={13} /> {t('schedule.agendaHeading')}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(meeting.agenda as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((item, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <span style={{
                            flexShrink: 0, width: 20, height: 20, borderRadius: 6,
                            background: 'var(--accent-soft, rgba(59,130,246,.12))', color: 'var(--accent, var(--accent))',
                            fontSize: 11, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
                          }}>{idx + 1}</span>
                          <span style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {meeting.participants && meeting.participants.length > 0 && (
                  <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                      {t('lobby.participantsHeading')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <AvatarStack users={getParticipantNames(meeting)} size="md" max={3} />
                      <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                        {t('common.participants', { count: meeting.participants.length })}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div>
                <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 10px', letterSpacing: '-0.02em' }}>
                  {id === 'quick' ? t('lobby.quickMeeting') : t('lobby.joinMeeting')}
                </h1>
                <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55, margin: 0 }}>
                  {id === 'quick'
                    ? t('lobby.quickMeetingDesc')
                    : t('lobby.loadingMeeting')}
                </p>
              </div>
            )}

            <div>
              <label className="field-label">{t('lobby.yourName')}</label>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)}
                placeholder={t('lobby.namePlaceholder')} />
            </div>

            {tooEarly ? (
              isHost ? (
                <>
                  <button className="btn btn-primary" onClick={() => joinMeeting(true)}
                    style={{ padding: '14px 18px', fontSize: 15, fontWeight: 600, justifyContent: 'center', borderRadius: 14 }}>
                    <Video size={17} /> {t('lobby.startNow')}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12.5 }}>
                    <Clock size={13} /> {t('lobby.earlyHostNote', { time: fmtTime(new Date(meeting.scheduledAt)) })}
                  </div>
                </>
              ) : (
                <div style={{ padding: '16px 18px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 600, fontSize: 14.5 }}>
                    <Clock size={16} style={{ color: 'var(--accent)' }} /> {t('lobby.tooEarlyTitle')}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                    {t('lobby.tooEarlyDesc', { time: fmtTime(new Date(meeting.scheduledAt)) })}
                  </div>
                </div>
              )
            ) : (
              <button className="btn btn-primary" onClick={() => joinMeeting()}
                style={{ padding: '14px 18px', fontSize: 15, fontWeight: 600, justifyContent: 'center', borderRadius: 14 }}>
                <Video size={17} /> {t('lobby.joinMeeting')}
              </button>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12 }}>
              <Lock size={12} /> {t('lobby.encryptedNote')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MEDIA PREVIEW — real camera + real mic level
   ══════════════════════════════════════════════════════════ */
function DeviceSelect({ label, icon, devices, value, onChange }: {
  label: string; icon: React.ReactNode; devices: MediaDeviceInfo[];
  value: string; onChange: (id: string) => void;
}) {
  const t = useTranslations();
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>
        {icon} {label}
      </div>
      <Select
        value={value}
        onChange={onChange}
        placeholder={t('lobby.deviceNotFound')}
        style={{ background: 'var(--surface-2)' }}
        options={devices.map(d => ({ value: d.deviceId, label: d.label || t('lobby.deviceFallback', { id: d.deviceId.slice(0, 6) }) }))}
      />
    </div>
  );
}

function MediaPreview({ mic, cam, userName, userInitial, selectedMic, selectedCam }: {
  mic: boolean; cam: boolean; userName: string; userInitial: string;
  selectedMic?: string; selectedCam?: string;
}) {
  const t = useTranslations();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micBarRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  /* ── Camera stream ───────────────────────── */
  useEffect(() => {
    if (!cam) {
      // Stop camera tracks
      if (streamRef.current) {
        streamRef.current.getVideoTracks().forEach(t => t.stop());
        // Keep audio tracks if mic is on
        if (!mic) {
          streamRef.current.getAudioTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedCam
            ? { deviceId: { exact: selectedCam }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: mic ? (selectedMic ? { deviceId: { exact: selectedMic } } : true) : false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Camera access error:', err);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam, selectedCam]);

  /* ── Mic analyser (real levels, DOM-direct updates) ── */
  useEffect(() => {
    if (!mic) {
      // Stop audio
      if (streamRef.current) {
        streamRef.current.getAudioTracks().forEach(t => t.stop());
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        analyserRef.current = null;
      }
      cancelAnimationFrame(rafRef.current);
      if (micBarRef.current) micBarRef.current.style.width = '0%';
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        // Get audio stream (reuse existing or create new)
        let stream = streamRef.current;
        if (!stream || stream.getAudioTracks().length === 0) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMic ? { deviceId: { exact: selectedMic } } : true });
          if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
          // Merge with existing video stream if present
          if (streamRef.current) {
            stream.getAudioTracks().forEach(t => streamRef.current!.addTrack(t));
          } else {
            streamRef.current = stream;
          }
        }

        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(dataArray);
          // Average of lower frequencies (voice range)
          let sum = 0;
          const count = Math.min(40, dataArray.length);
          for (let i = 0; i < count; i++) sum += dataArray[i];
          const avg = sum / count / 255;
          // Direct DOM update — no setState, no re-render
          if (micBarRef.current) {
            micBarRef.current.style.width = `${Math.min(avg * 2.5, 1) * 100}%`;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        console.error('Mic access error:', err);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic, selectedMic]);

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return (
    <div style={{
      position: 'relative', aspectRatio: '16/9', borderRadius: 20, overflow: 'hidden',
      background: 'linear-gradient(135deg, #1d2735 0%, #0f1722 100%)',
      border: '1px solid var(--border)', boxShadow: '0 30px 60px -20px var(--overlay)',
    }}>
      {/* Real camera video */}
      {cam && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)',
          }}
        />
      )}

      {/* Camera off placeholder */}
      {!cam && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12,
          background: 'var(--surface)',
        }}>
          <div className="avatar avatar-lg" style={{
            width: 80, height: 80, fontSize: 28,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '50%', color: 'var(--on-accent)', fontWeight: 700,
          }}>
            {userInitial}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('lobby.cameraOff')}</div>
        </div>
      )}

      {/* Bottom bar: mic level + name */}
      <div style={{
        position: 'absolute', left: 16, bottom: 16, right: 16,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', background: 'rgba(0,0,0,.45)',
        borderRadius: 10, backdropFilter: 'blur(10px)',
      }}>
        {mic ? (
          <Mic size={14} style={{ color: 'var(--on-accent)', flexShrink: 0 }} />
        ) : (
          <MicOff size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.15)', overflow: 'hidden' }}>
          <div
            ref={micBarRef}
            style={{
              height: '100%', width: '0%',
              background: 'linear-gradient(90deg, #22c55e, #eab308)',
              borderRadius: 2,
              transition: 'width .06s linear',
            }}
          />
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--on-accent)', flexShrink: 0 }}>{userName}</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */
function LobbyControlBtn({ active, onClick, icon }: { active: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      width: 52, height: 52, borderRadius: 14, cursor: 'pointer',
      background: active ? 'var(--surface-2)' : 'color-mix(in oklab, var(--red) 22%, var(--surface))',
      color: active ? 'var(--text)' : '#fca5a5',
      border: `1px solid ${active ? 'var(--border)' : 'color-mix(in oklab, var(--red) 40%, var(--border))'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s',
    }}>
      {icon}
    </button>
  );
}
