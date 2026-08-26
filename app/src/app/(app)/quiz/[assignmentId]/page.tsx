'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Loader2, Check, X, ClipboardList, BookOpen, ChevronLeft } from 'lucide-react';

interface Opt {
  id: string;
  text: string;
}
interface Q {
  id: string;
  prompt: string;
  type: 'single' | 'multi';
  options: Opt[];
  correctOptionIds?: string[];
}
interface Assignment {
  id: string;
  status: string;
  score: number | null;
  maxScore: number | null;
  openBook: boolean;
  meetingId: string;
  meetingTitle: string;
  questions: Q[];
  answers?: Record<string, string[]>;
}

export default function QuizTakerPage() {
  const tr = useTranslations();
  const { assignmentId } = useParams() as { assignmentId: string };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [a, setA] = useState<Assignment | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ score: number; maxScore: number; correctOptionIds: Record<string, string[]> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/quiz/${assignmentId}`);
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = await res.json();
      setA(data.assignment);
      if (data.assignment?.answers) setAnswers(data.assignment.answers);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const completed = a?.status === 'completed';
  const showFeedback = !!result || completed;
  const correctMap: Record<string, string[]> =
    result?.correctOptionIds ??
    (completed ? Object.fromEntries((a?.questions || []).map((q) => [q.id, q.correctOptionIds || []])) : {});

  const toggle = (q: Q, optId: string) => {
    if (showFeedback) return;
    setAnswers((prev) => {
      const cur = prev[q.id] || [];
      if (q.type === 'single') return { ...prev, [q.id]: [optId] };
      return { ...prev, [q.id]: cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId] };
    });
  };

  const questions = a?.questions || [];
  const allAnswered = questions.length > 0 && questions.every((q) => (answers[q.id] || []).length > 0);
  const shownScore = result?.score ?? a?.score ?? 0;
  const shownMax = result?.maxScore ?? a?.maxScore ?? questions.length;

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/quiz/${assignmentId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ score: data.score, maxScore: data.maxScore, correctOptionIds: data.correctOptionIds });
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch {
      /* ignore */
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
      </div>
    );
  }
  if (error || !a) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40, textAlign: 'center' }}>
        <ClipboardList size={28} style={{ color: 'var(--muted)', opacity: 0.4 }} />
        <div style={{ color: 'var(--muted)', fontSize: 14 }}>{tr('quiz.loadError')}</div>
        <button className="btn btn-sm" onClick={load}>{tr('quiz.retry')}</button>
        <Link href="/" className="btn btn-ghost btn-sm" style={{ color: 'var(--muted)' }}>{tr('quiz.backHome')}</Link>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px 80px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div>
          <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--muted)', textDecoration: 'none', marginBottom: 10 }}>
            <ChevronLeft size={15} /> {tr('quiz.backHome')}
          </Link>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em' }}>{tr('quiz.takeTitle')}</h1>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 4 }}>{a.meetingTitle}</div>
          {a.openBook && !showFeedback && (
            <Link href={`/meetings/${a.meetingId}/report`} target="_blank" className="btn btn-ghost btn-sm" style={{ marginTop: 10, color: 'var(--accent)' }}>
              <BookOpen size={14} /> {tr('quiz.viewReport')}
            </Link>
          )}
        </div>

        {/* Score banner */}
        {showFeedback && (
          <div className="card" style={{ padding: 18, textAlign: 'center', background: 'color-mix(in oklab, var(--green) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--green) 30%, transparent)' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4 }}>{tr('quiz.yourScore')}</div>
            <div style={{ fontSize: 30, fontWeight: 700, fontFamily: 'var(--mono, monospace)' }}>
              {shownScore}<span style={{ color: 'var(--muted)', fontSize: 20 }}>/{shownMax}</span>
            </div>
          </div>
        )}

        {/* Questions */}
        {questions.map((q, qi) => {
          const sel = answers[q.id] || [];
          const correct = correctMap[q.id] || [];
          return (
            <div key={q.id} className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>{qi + 1}.</span>
                <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{q.prompt}</span>
              </div>
              {q.type === 'multi' && !showFeedback && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -6 }}>{tr('quiz.multiHint')}</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {q.options.map((o) => {
                  const picked = sel.includes(o.id);
                  const isCorrect = correct.includes(o.id);
                  let border = 'var(--border)';
                  let bg = 'transparent';
                  if (showFeedback) {
                    if (isCorrect) { border = 'var(--green)'; bg = 'color-mix(in oklab, var(--green) 12%, transparent)'; }
                    else if (picked && !isCorrect) { border = 'var(--danger-fg)'; bg = 'color-mix(in oklab, var(--danger-fg) 12%, transparent)'; }
                  } else if (picked) {
                    border = 'var(--accent)'; bg = 'color-mix(in oklab, var(--accent) 12%, transparent)';
                  }
                  return (
                    <button
                      key={o.id}
                      onClick={() => toggle(q, o.id)}
                      disabled={showFeedback}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                        padding: '12px 14px', borderRadius: 10, cursor: showFeedback ? 'default' : 'pointer',
                        border: `1.5px solid ${border}`, background: bg, color: 'var(--text)', fontSize: 14, lineHeight: 1.4,
                      }}
                    >
                      <span style={{
                        width: 20, height: 20, flexShrink: 0, borderRadius: q.type === 'single' ? '50%' : 6,
                        border: `1.5px solid ${picked || (showFeedback && isCorrect) ? 'currentColor' : 'var(--border)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: showFeedback ? (isCorrect ? 'var(--green)' : picked ? 'var(--danger-fg)' : 'var(--muted)') : 'var(--accent)',
                      }}>
                        {showFeedback ? (isCorrect ? <Check size={13} /> : picked ? <X size={13} /> : null) : picked ? <Check size={13} /> : null}
                      </span>
                      <span style={{ flex: 1 }}>{o.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Submit */}
        {!showFeedback && (
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!allAnswered || submitting}
            style={{ alignSelf: 'stretch', justifyContent: 'center', padding: '12px 0', fontSize: 15 }}
          >
            {submitting ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <ClipboardList size={16} />}
            {tr('quiz.submit')}
          </button>
        )}
        {showFeedback && (
          <Link href="/" className="btn" style={{ alignSelf: 'center', color: 'var(--muted)', textDecoration: 'none' }}>
            {tr('quiz.done')}
          </Link>
        )}
      </div>
    </div>
  );
}
