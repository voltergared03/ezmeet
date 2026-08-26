'use client';

import { useTranslations } from 'next-intl';
import { VideoTrack } from '@livekit/components-react';
import { MicOff } from 'lucide-react';

/* ══════════════════════════════════════════════════════════
   PARTICIPANT TILE
   ══════════════════════════════════════════════════════════ */
export function ParticipantTile({ track, small, fill }: { track: any; small?: boolean; fill?: boolean }) {
  const t = useTranslations();
  const p = track.participant;
  const isCamOn = p.isCameraEnabled;
  const isMicOn = p.isMicrophoneEnabled;
  const isSpeaking = p.isSpeaking;
  const isLocal = p.isLocal;

  return (
    <div style={{
      position: 'relative', borderRadius: small ? 10 : 14, overflow: 'hidden',
      background: '#22252b',
      ...(fill ? { width: '100%', height: '100%' } : { aspectRatio: '16/9' }),
      border: isSpeaking ? '2px solid var(--accent)' : '2px solid transparent',
      transition: 'border-color .2s', maxHeight: small ? 140 : undefined,
    }}>
      {isCamOn && track.publication?.track ? (
        <VideoTrack trackRef={track} style={{
          width: '100%', height: '100%', objectFit: 'cover',
          position: 'absolute', inset: 0,
          ...(isLocal ? { transform: 'scaleX(-1)' } : {}),
        }} />
      ) : (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(145deg, #2a2d35 0%, #1a1d25 100%)',
        }}>
          <div style={{
            width: small ? 48 : 80, height: small ? 48 : 80,
            borderRadius: '50%', background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: small ? 20 : 32, fontWeight: 700, color: 'var(--on-accent)',
            boxShadow: '0 4px 20px rgba(59,130,246,.3)',
          }}>
            {(p.name || p.identity || 'U')[0]?.toUpperCase()}
          </div>
        </div>
      )}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: small ? '6px 8px' : '8px 12px',
        background: 'linear-gradient(transparent, var(--overlay))',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {!isMicOn && (
          <span style={{
            width: 22, height: 22, borderRadius: 6,
            background: 'rgba(239,68,68,.25)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}><MicOff size={12} style={{ color: 'var(--danger-fg)' }} /></span>
        )}
        <span style={{
          fontSize: small ? 11 : 13, color: 'var(--on-accent)', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {p.name || p.identity}{isLocal ? ` (${t('room.you')})` : ''}
        </span>
      </div>
    </div>
  );
}
