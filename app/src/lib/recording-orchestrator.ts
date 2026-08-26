import { readFile } from 'fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { readConfig } from './config';
import {
  RECORDINGS_DIR,
  startRoomRecording,
  startAudioOnlyRecording,
  startScreenTrackEgress,
  stopRecording,
} from './egress';
import { composeScreenAudio, probeDurationSec } from './recording-compose';
import { notify } from './notify';

/** Recording strategy. Gated by the WS_RECORD_MODE workspace config. */
export type RecordMode = 'composite' | 'screen-audio';

export async function getRecordMode(): Promise<RecordMode> {
  try {
    const c = await readConfig(['WS_RECORD_MODE']);
    return c.WS_RECORD_MODE === 'screen-audio' ? 'screen-audio' : 'composite';
  } catch {
    return 'composite';
  }
}

/**
 * The actual on-disk filename for an egress — read from its `EG_<id>.json` manifest,
 * which LiveKit writes next to the output. The container/extension depends on the track
 * codec (e.g. a VP8 screen-share lands as .webm even if we requested .mp4), so the
 * requested name in meta can be wrong; the manifest is authoritative.
 */
async function egressInfo(
  egressId: string | undefined | null,
  fallbackFile: string,
): Promise<{ file: string; endedNs: number | null }> {
  if (!egressId) return { file: fallbackFile, endedNs: null };
  try {
    const raw = await readFile(`${RECORDINGS_DIR}/${egressId}.json`, 'utf8');
    const j = JSON.parse(raw);
    const fn = j?.files?.[0]?.filename || j?.file?.filename;
    const ended = Number(j?.ended_at);
    return {
      file: fn ? (String(fn).split('/').pop() as string) : fallbackFile,
      endedNs: Number.isFinite(ended) && ended > 0 ? ended : null,
    };
  } catch {
    /* manifest missing/unreadable → use the requested name, no timestamp */
    return { file: fallbackFile, endedNs: null };
  }
}

/**
 * Wall-clock time (ms) of the FIRST media sample in an egress file. Egress `started_at`
 * is when the job launched, but actual media begins after startup latency (room-composite
 * audio waits for headless Chrome to join + subscribe → several seconds; a raw screen
 * TrackEgress is near-instant). Since the file ENDS promptly when the egress stops, the
 * reliable media-start = ended_at − fileDuration. Aligning two egresses by this removes
 * the differing-startup-latency skew that a `started_at` delta would leave behind.
 */
async function mediaStartMs(egressId: string | undefined | null, file: string): Promise<number | null> {
  const info = await egressInfo(egressId, file);
  if (info.endedNs == null) return null;
  const dur = await probeDurationSec(`${RECORDINGS_DIR}/${info.file}`);
  if (!(dur > 0)) return null;
  return info.endedNs / 1e6 - dur * 1000;
}

async function retentionDays(): Promise<number> {
  try {
    const c = await readConfig(['WS_RETENTION_DAYS']);
    return parseInt(c.WS_RETENTION_DAYS || '0', 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Start a recording in the configured mode and create its Recording row.
 * - composite (legacy): room-composite grid MP4.
 * - screen-audio (B2-lite): continuous mixed audio (audio-only room-composite); the
 *   agent adds screen-share TrackEgress segments on top, composed offline at the end.
 * Returns true if an egress was started.
 */
export async function beginRecording(meetingId: string, roomName: string): Promise<boolean> {
  const mode = await getRecordMode();
  if (mode === 'screen-audio') {
    const aud = await startAudioOnlyRecording(roomName);
    if (!aud) return false;
    await prisma.recording.create({
      data: {
        meetingId,
        egressId: aud.egressId,
        fileName: aud.fileName,
        filePath: aud.filePath,
        status: 'processing',
        sourceType: 'screen-audio',
        meta: { audioEgressId: aud.egressId, audioFile: aud.fileName, screenSegments: [] },
      },
    });
    return true;
  }
  const rec = await startRoomRecording(roomName);
  if (!rec) return false;
  await prisma.recording.create({
    data: {
      meetingId,
      egressId: rec.egressId,
      fileName: rec.fileName,
      filePath: rec.filePath,
      status: 'processing',
      sourceType: 'egress',
    },
  });
  return true;
}

/** Stop a recording: its main egress + (screen-audio) any in-flight screen segments. */
export async function endRecording(rec: {
  egressId: string | null;
  sourceType: string | null;
  meta: unknown;
}): Promise<void> {
  if (rec.egressId) await stopRecording(rec.egressId);
  if (rec.sourceType === 'screen-audio') {
    const meta = (rec.meta as { screenSegments?: { egressId?: string; stopped?: boolean }[] }) || {};
    for (const s of meta.screenSegments || []) {
      if (s.egressId && !s.stopped) await stopRecording(s.egressId).catch(() => {});
    }
  }
}

/** Agent: a screen-share track started → record it as a TrackEgress segment. */
export async function addScreenSegment(meetingId: string, roomName: string, trackId: string): Promise<boolean> {
  const rec = await prisma.recording.findFirst({
    where: { meetingId, status: 'processing', sourceType: 'screen-audio' },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) return false;
  const seg = await startScreenTrackEgress(roomName, trackId);
  if (!seg) return false;
  const startSec = Math.max(0, (Date.now() - rec.createdAt.getTime()) / 1000);
  const meta = (rec.meta as { screenSegments?: unknown[] }) || {};
  const screenSegments = [
    ...((meta.screenSegments as unknown[]) || []),
    { egressId: seg.egressId, fileName: seg.fileName, trackId, startSec, stopped: false },
  ];
  await prisma.recording.update({ where: { id: rec.id }, data: { meta: { ...meta, screenSegments } as Prisma.InputJsonValue } });
  return true;
}

/** Agent: a screen-share track ended → stop its TrackEgress segment. */
export async function stopScreenSegment(meetingId: string, trackId: string): Promise<void> {
  const rec = await prisma.recording.findFirst({
    where: { meetingId, status: 'processing', sourceType: 'screen-audio' },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) return;
  const meta = (rec.meta as { screenSegments?: { egressId?: string; trackId?: string; stopped?: boolean }[] }) || {};
  const segs = meta.screenSegments || [];
  const seg = [...segs].reverse().find((s) => s.trackId === trackId && !s.stopped);
  if (seg?.egressId) {
    await stopRecording(seg.egressId).catch(() => {});
    seg.stopped = true;
    await prisma.recording.update({ where: { id: rec.id }, data: { meta: { ...meta, screenSegments: segs } as Prisma.InputJsonValue } });
  }
}

/**
 * Mark a recording failed AND tell somebody.
 *
 * A failed recording used to be completely silent: the row flipped to "failed", no
 * screen renders that state, and the meeting simply looked like one that was never
 * recorded. On 2026-08-26 a 52-minute call lost its audio four minutes in — the egress
 * CPU guard killed the handler — and nobody found out until someone went looking for
 * the file hours later, by which point the meeting could not be re-run.
 *
 * The transcript and the AI report survive independently (the agent subscribes to the
 * tracks directly, no browser involved), so only the media file is lost — but whoever
 * called the meeting is the person who needs to know that.
 */
async function failRecording(recordingId: string, reason: string): Promise<void> {
  console.error(`[recording] ${recordingId} failed: ${reason}`);
  let meetingId: string | null = null;
  let title = '';
  let createdById: string | null = null;
  try {
    const rec = await prisma.recording.update({
      where: { id: recordingId },
      data: { status: 'failed' },
      select: { meetingId: true, meeting: { select: { title: true, createdById: true } } },
    });
    meetingId = rec.meetingId;
    title = rec.meeting?.title || '';
    createdById = rec.meeting?.createdById ?? null;
  } catch (e) {
    console.error('[recording] could not mark failed:', (e as Error).message);
    return;
  }
  // Notifying is best-effort and must never undo the status write above.
  try {
    const admins = await prisma.user.findMany({ where: { role: 'admin', status: 'active' }, select: { id: true } });
    const userIds = [...new Set([createdById, ...admins.map((a) => a.id)].filter(Boolean) as string[])];
    if (userIds.length && meetingId) {
      await notify({
        userIds,
        type: 'recording_failed',
        titleKey: 'recordingFailedTitle',
        bodyKey: 'recordingFailedBody',
        values: { title },
        link: `/meetings/${meetingId}/report`,
        meetingId,
      });
    }
  } catch (e) {
    console.error('[recording] failure notify skipped:', (e as Error).message);
  }
}

/**
 * Called when the AUDIO egress of a screen-audio recording ends (= recording over).
 * After a short grace (screen TrackEgress files finish writing), compose the final MP4.
 * Runs fire-and-forget in the long-lived Node server; updates the Recording when done.
 */
export function finalizeScreenAudio(recordingId: string): void {
  setTimeout(async () => {
    try {
      const rec = await prisma.recording.findUnique({ where: { id: recordingId } });
      if (!rec || rec.sourceType !== 'screen-audio') return;
      const meta = (rec.meta as { audioEgressId?: string; audioFile?: string; screenSegments?: { egressId?: string; fileName: string; startSec: number }[] }) || {};
      const audio = await egressInfo(meta.audioEgressId, meta.audioFile || '');
      if (!audio.file) {
        await failRecording(rec.id, 'audio egress produced no file (killed, or never started)');
        return;
      }
      // Place each screen segment by the real MEDIA-start delta vs the audio (ended_at −
      // file duration), so the differing egress startup latencies don't skew the timeline.
      const audioStartMs = await mediaStartMs(meta.audioEgressId, audio.file);
      const segs = await Promise.all(
        (meta.screenSegments || []).map(async (s) => {
          const info = await egressInfo(s.egressId, s.fileName);
          const segStartMs = await mediaStartMs(s.egressId, info.file);
          const startSec =
            audioStartMs != null && segStartMs != null
              ? Math.max(0, (segStartMs - audioStartMs) / 1000)
              : s.startSec;
          return { fileName: info.file, startSec };
        }),
      );
      const audioFile = audio.file;
      const res = await composeScreenAudio({ audioFileName: audioFile, screenSegments: segs, outFileName: `rec-${rec.id}.mp4` });
      if (res.ok && res.outFile) {
        const days = await retentionDays();
        await prisma.recording.update({
          where: { id: rec.id },
          data: {
            status: 'ready',
            fileName: res.outFile,
            filePath: `${RECORDINGS_DIR}/${res.outFile}`,
            durationSec: res.durationSec ?? null,
            fileSize: res.fileSize != null ? BigInt(res.fileSize) : null,
            ...(days > 0 ? { expiresAt: new Date(Date.now() + days * 86400000) } : {}),
          },
        });
      } else {
        await failRecording(rec.id, `compose failed: ${res.error}`);
      }
    } catch (e) {
      await failRecording(recordingId, `finalize threw: ${(e as Error).message}`);
    }
  }, 6000);
}
