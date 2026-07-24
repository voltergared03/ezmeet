import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { promises as fs } from 'fs';
import path from 'path';
import { RECORDINGS_DIR } from '@/lib/egress';
import { withRoute } from '@/lib/with-route';

// Files older than this with no owning DB row are treated as leftovers and pruned.
// Generous so an in-flight recording (whose row is created before egress) is never at risk.
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 1 day
// Per-speaker WAVs are a transient processing artifact (post-meeting language detection +
// the occasional fix-language re-transcription). They are the single biggest disk leak, so
// keep a bounded window rather than forever.
const SPEAKER_AUDIO_DIR = process.env.SPEAKER_AUDIO_DIR || '/speaker-audio';
const SPEAKER_AUDIO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// GET /api/cron/recordings?secret=XXX — daily storage housekeeping:
//   1. delete recordings whose retention window expired (file + DB row), skipping permanent;
//   2. prune ORPHAN files in the recordings dir that no Recording row references (the source
//      segments left behind after a screen-audio compose, and files from failed recordings —
//      neither of which the expiry pass above can ever see, so the disk grew unbounded);
//   3. prune per-speaker WAVs older than the retention window.
async function getHandler(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = Date.now();

  // ── 1. Expired retained recordings (file + row) ──
  const expired = await prisma.recording.findMany({
    where: { permanent: false, expiresAt: { not: null, lte: new Date(now) } },
  });
  let deleted = 0;
  for (const rec of expired) {
    if (rec.filePath) await fs.unlink(rec.filePath).catch(() => {});
    await prisma.recording.delete({ where: { id: rec.id } }).catch(() => {});
    deleted++;
  }

  // ── 2. Orphan files in the recordings dir ──
  // A file is KEPT if any Recording row references it — as its main file (filePath) OR as a
  // source file inside meta (audioFile / screenSegments[].fileName). Only files referenced by
  // NOTHING, and older than the safety window, are removed.
  let orphansPruned = 0;
  try {
    const all = await prisma.recording.findMany({ select: { filePath: true, meta: true } });
    const referenced = new Set<string>();
    for (const r of all) {
      if (r.filePath) referenced.add(path.basename(r.filePath));
      const meta = (r.meta as { audioFile?: string; screenSegments?: { fileName?: string }[] } | null) || {};
      if (meta.audioFile) referenced.add(path.basename(meta.audioFile));
      for (const s of meta.screenSegments || []) if (s?.fileName) referenced.add(path.basename(s.fileName));
    }
    orphansPruned = await pruneDir(RECORDINGS_DIR, now - ORPHAN_AGE_MS, (name) => !referenced.has(name));
  } catch (e) {
    console.error('[cron:recordings] orphan prune failed:', (e as Error).message);
  }

  // ── 3. Old per-speaker WAVs ──
  let speakerAudioPruned = 0;
  try {
    speakerAudioPruned = await pruneDir(SPEAKER_AUDIO_DIR, now - SPEAKER_AUDIO_MAX_AGE_MS, () => true);
  } catch (e) {
    console.error('[cron:recordings] speaker-audio prune failed:', (e as Error).message);
  }

  return NextResponse.json({ deleted, orphansPruned, speakerAudioPruned });
}

/** Delete regular files in `dir` older than `olderThanMs` (by mtime) that also pass `deletable`.
 *  Best-effort: a failure on one file never aborts the sweep, and a missing dir is a no-op. */
async function pruneDir(dir: string, olderThanMs: number, deletable: (basename: string) => boolean): Promise<number> {
  let n = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // dir not mounted / absent → nothing to do
  }
  for (const name of entries) {
    if (!deletable(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > olderThanMs) continue; // too fresh — keep
      await fs.unlink(full);
      n++;
    } catch {
      /* skip this file */
    }
  }
  return n;
}

export const GET = withRoute('cron.recordings', getHandler);
