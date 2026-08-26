'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardList, Wand2, Plus, Trash2, Check, Loader2, BookOpen, BookLock } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useTransientMessage } from '@/hooks/use-transient-message';
import type { Participant } from '../lib/types';
import type { QuizQuestion } from '@/lib/quiz';

interface Assignment {
  id: string;
  user: { id: string; name: string; email?: string | null } | null;
  status: string;
  score: number | null;
  maxScore: number | null;
  completedAt: string | null;
}
interface QuizData {
  id: string;
  status: string;
  openBook: boolean;
  questions: QuizQuestion[];
  assignments?: Assignment[];
}

const uid = () => Math.random().toString(36).slice(2, 8);

/** Admin/creator-only: generate, edit and assign a post-meeting comprehension quiz. */
export function QuizManager({
  meetingId,
  participants,
  reportReady,
  canManage,
}: {
  meetingId: string;
  participants: Participant[];
  reportReady: boolean;
  canManage: boolean;
}) {
  const tr = useTranslations();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [openBook, setOpenBook] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [msg, showMsg] = useTransientMessage();

  const registered = participants.filter((p) => p.user);
  const assignments = quiz?.assignments ?? [];

  const openModal = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/quiz`);
      const data = res.ok ? await res.json() : {};
      const q: QuizData | null = data.quiz || null;
      setQuiz(q);
      setQuestions(q?.questions ?? []);
      setOpenBook(!!q?.openBook);
      const assignedIds = new Set((q?.assignments ?? []).map((a) => a.user?.id).filter(Boolean));
      // Pre-select registered participants who aren't assigned yet.
      setSelected(new Set(registered.map((p) => p.user!.id).filter((uidv) => !assignedIds.has(uidv))));
    } catch {
      setQuiz(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/quiz/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openBook }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMsg(false, data.error === 'report_not_ready' ? tr('quiz.reportNotReady') : tr('quiz.generateFailed'));
        return;
      }
      setQuestions(data.quiz?.questions ?? []);
    } catch {
      showMsg(false, tr('quiz.generateFailed'));
    } finally {
      setGenerating(false);
    }
  }, [meetingId, openBook, tr, showMsg]);

  /* ── question editing (immutable) ── */
  const setQ = (qi: number, patch: Partial<QuizQuestion>) =>
    setQuestions((qs) => qs.map((q, i) => (i === qi ? { ...q, ...patch } : q)));
  const setOptText = (qi: number, oi: number, text: string) =>
    setQuestions((qs) =>
      qs.map((q, i) => (i === qi ? { ...q, options: q.options.map((o, j) => (j === oi ? { ...o, text } : o)) } : q)),
    );
  const toggleCorrect = (qi: number, optId: string) =>
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qi) return q;
        if (q.type === 'single') return { ...q, correctOptionIds: [optId] };
        const has = q.correctOptionIds.includes(optId);
        return { ...q, correctOptionIds: has ? q.correctOptionIds.filter((c) => c !== optId) : [...q.correctOptionIds, optId] };
      }),
    );
  const setType = (qi: number, type: 'single' | 'multi') =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi ? { ...q, type, correctOptionIds: type === 'single' ? q.correctOptionIds.slice(0, 1) : q.correctOptionIds } : q,
      ),
    );
  const addOption = (qi: number) =>
    setQuestions((qs) =>
      qs.map((q, i) => (i === qi ? { ...q, options: [...q.options, { id: `o_${uid()}`, text: '' }] } : q)),
    );
  const deleteOption = (qi: number, optId: string) =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi && q.options.length > 2
          ? { ...q, options: q.options.filter((o) => o.id !== optId), correctOptionIds: q.correctOptionIds.filter((c) => c !== optId) }
          : q,
      ),
    );
  const addQuestion = () =>
    setQuestions((qs) => [
      ...qs,
      { id: `q_${uid()}`, prompt: '', type: 'single', options: [{ id: `o_${uid()}`, text: '' }, { id: `o_${uid()}`, text: '' }], correctOptionIds: [], cites: [] },
    ]);
  const deleteQuestion = (qi: number) => setQuestions((qs) => qs.filter((_, i) => i !== qi));

  /* ── validation ── */
  function validate(): string | null {
    if (questions.length === 0) return tr('quiz.errNoQuestions');
    for (const q of questions) {
      if (!q.prompt.trim()) return tr('quiz.errEmptyPrompt');
      const opts = q.options.filter((o) => o.text.trim());
      if (opts.length < 2) return tr('quiz.errFewOptions');
      const validCorrect = q.correctOptionIds.filter((c) => q.options.some((o) => o.id === c && o.text.trim()));
      if (validCorrect.length < 1) return tr('quiz.errNoCorrect');
    }
    return null;
  }

  const saveAndAssign = useCallback(async () => {
    const err = validate();
    if (err) { showMsg(false, err); return; }
    if (selected.size === 0) { showMsg(false, tr('quiz.errNoUsers')); return; }
    setAssigning(true);
    try {
      // 1) persist the (possibly edited) questions + openBook
      const patch = await fetch(`/api/meetings/${meetingId}/quiz`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions, openBook }),
      });
      if (!patch.ok) { showMsg(false, tr('quiz.saveFailed')); return; }
      // 2) assign to the selected participants
      const res = await fetch(`/api/meetings/${meetingId}/quiz/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showMsg(false, tr('quiz.assignFailed')); return; }
      showMsg(true, tr('quiz.assignedCount', { count: data.assigned ?? 0 }));
      // refresh quiz/results
      const ref = await fetch(`/api/meetings/${meetingId}/quiz`);
      if (ref.ok) {
        const rd = await ref.json();
        setQuiz(rd.quiz || null);
        setSelected(new Set());
      }
    } catch {
      showMsg(false, tr('quiz.assignFailed'));
    } finally {
      setAssigning(false);
    }
  }, [meetingId, questions, openBook, selected, tr, showMsg]);

  const deleteQuiz = useCallback(async () => {
    if (!confirm(tr('quiz.deleteConfirm'))) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/quiz`, { method: 'DELETE' });
      if (!res.ok) {
        showMsg(false, tr('quiz.deleteFailed'));
        return;
      }
      setQuiz(null);
      setQuestions([]);
      setSelected(new Set());
      setOpen(false);
    } catch {
      showMsg(false, tr('quiz.deleteFailed'));
    } finally {
      setAssigning(false);
    }
  }, [meetingId, tr, showMsg]);

  if (!canManage) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--surface-2, rgba(255,255,255,.03))', color: 'var(--text)', fontSize: 13, outline: 'none',
  };

  return (
    <>
      <button
        className="btn btn-sm"
        onClick={openModal}
        disabled={!reportReady}
        title={reportReady ? undefined : tr('quiz.needReport')}
        style={{ opacity: reportReady ? 1 : 0.5 }}
      >
        <ClipboardList size={13} /> {tr('quiz.assignButton')}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={tr('quiz.title')} width={680}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <Loader2 size={22} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '70vh', overflowY: 'auto' }}>
            {/* Existing results */}
            {assignments.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                  {tr('quiz.results')}
                </div>
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {assignments.map((a) => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.user?.name || a.user?.email || '—'}</span>
                      {a.status === 'completed' ? (
                        <span style={{ color: 'var(--green)', fontWeight: 600, fontFamily: 'var(--mono, monospace)' }}>{a.score}/{a.maxScore}</span>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{tr('quiz.pending')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Participants */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  {tr('quiz.selectParticipants')}
                </span>
                {registered.length > 0 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setSelected((s) => (s.size === registered.length ? new Set() : new Set(registered.map((p) => p.user!.id))))
                    }
                    style={{ fontSize: 12, color: 'var(--muted)' }}
                  >
                    {selected.size === registered.length ? tr('quiz.clearAll') : tr('quiz.selectAll')}
                  </button>
                )}
              </div>
              {registered.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 0' }}>{tr('quiz.noRegistered')}</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {registered.map((p) => {
                    const id = p.user!.id;
                    const on = selected.has(id);
                    return (
                      <button
                        key={id}
                        onClick={() => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999,
                          fontSize: 13, cursor: 'pointer',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                          background: on ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : 'transparent',
                          color: on ? 'var(--text)' : 'var(--muted)',
                        }}
                      >
                        {on && <Check size={12} />}
                        {p.user!.name || p.user!.email}
                      </button>
                    );
                  })}
                </div>
              )}
              {participants.some((p) => !p.user && p.guestName) && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{tr('quiz.guestsCantTake')}</div>
              )}
            </div>

            {/* Open-book toggle */}
            <button
              onClick={() => setOpenBook((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', textAlign: 'left',
              }}
            >
              {openBook ? <BookOpen size={16} style={{ color: 'var(--accent)' }} /> : <BookLock size={16} style={{ color: 'var(--muted)' }} />}
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{tr('quiz.openBook')}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{tr('quiz.openBookHint')}</span>
              </span>
              <span style={{
                width: 38, height: 22, borderRadius: 999, flexShrink: 0, position: 'relative',
                background: openBook ? 'var(--accent)' : 'var(--surface-3, rgba(255,255,255,.1))', transition: 'background .15s',
              }}>
                <span style={{ position: 'absolute', top: 3, left: openBook ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
              </span>
            </button>

            {/* Questions */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  {tr('quiz.questions')} {questions.length > 0 && `(${questions.length})`}
                </span>
                <button className="btn btn-sm" onClick={generate} disabled={generating}>
                  {generating ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Wand2 size={13} />}
                  {questions.length > 0 ? tr('quiz.regenerate') : tr('quiz.generate')}
                </button>
              </div>

              {questions.length === 0 && !generating && (
                <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0', textAlign: 'center' }}>{tr('quiz.generateHint')}</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {questions.map((q, qi) => (
                  <div key={q.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, paddingTop: 8 }}>{qi + 1}.</span>
                      <textarea
                        value={q.prompt}
                        onChange={(e) => setQ(qi, { prompt: e.target.value })}
                        placeholder={tr('quiz.promptPlaceholder')}
                        rows={2}
                        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }}
                      />
                      <button onClick={() => deleteQuestion(qi)} title={tr('common.delete')} aria-label={tr('common.delete')}
                        style={{ background: 'none', border: 'none', color: 'var(--danger-fg)', cursor: 'pointer', padding: 6, flexShrink: 0 }}>
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: 6, paddingLeft: 22 }}>
                      {(['single', 'multi'] as const).map((t) => (
                        <button key={t} onClick={() => setType(qi, t)}
                          style={{
                            fontSize: 11.5, padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
                            border: `1px solid ${q.type === t ? 'var(--accent)' : 'var(--border)'}`,
                            background: q.type === t ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent',
                            color: q.type === t ? 'var(--text)' : 'var(--muted)',
                          }}>
                          {t === 'single' ? tr('quiz.typeSingle') : tr('quiz.typeMulti')}
                        </button>
                      ))}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 22 }}>
                      {q.options.map((o, oi) => {
                        const correct = q.correctOptionIds.includes(o.id);
                        return (
                          <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button
                              onClick={() => toggleCorrect(qi, o.id)}
                              title={tr('quiz.markCorrect')}
                              aria-label={tr('quiz.markCorrect')}
                              style={{
                                width: 20, height: 20, flexShrink: 0, cursor: 'pointer',
                                borderRadius: q.type === 'single' ? '50%' : 6,
                                border: `1.5px solid ${correct ? 'var(--green)' : 'var(--border)'}`,
                                background: correct ? 'var(--green)' : 'transparent',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                              }}>
                              {correct && <Check size={12} style={{ color: 'var(--on-accent)' }} />}
                            </button>
                            <input value={o.text} onChange={(e) => setOptText(qi, oi, e.target.value)} placeholder={tr('quiz.optionPlaceholder')} style={inputStyle} />
                            {q.options.length > 2 && (
                              <button onClick={() => deleteOption(qi, o.id)} aria-label={tr('common.delete')}
                                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <button className="btn btn-ghost btn-sm" onClick={() => addOption(qi)} style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--muted)' }}>
                        <Plus size={12} /> {tr('quiz.addOption')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {questions.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={addQuestion} style={{ marginTop: 10, color: 'var(--muted)' }}>
                  <Plus size={13} /> {tr('quiz.addQuestion')}
                </button>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              {quiz || questions.length > 0 ? (
                <button onClick={deleteQuiz} disabled={assigning}
                  style={{ background: 'none', border: 'none', color: 'var(--danger-fg)', cursor: 'pointer', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0 }}>
                  <Trash2 size={13} /> {tr('quiz.delete')}
                </button>
              ) : <span />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 12.5, color: msg ? (msg.ok ? 'var(--green)' : 'var(--danger-fg)') : 'var(--muted)' }}>
                  {msg ? msg.text : tr('quiz.selectedCount', { count: selected.size })}
                </span>
                <button className="btn btn-primary" onClick={saveAndAssign} disabled={assigning || questions.length === 0 || selected.size === 0}>
                  {assigning ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <ClipboardList size={14} />}
                  {tr('quiz.assignButton')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
