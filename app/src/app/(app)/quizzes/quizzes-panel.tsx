'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClipboardList, Check, X, ChevronDown, ChevronRight, Loader2, Users, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';

interface MyItem {
  id: string;
  status: string;
  score: number | null;
  maxScore: number | null;
  meetingId: string;
  meetingTitle: string;
  questionCount: number;
}
interface MgAssignment {
  id: string;
  user: { id: string; name: string; email?: string | null } | null;
  status: string;
  score: number | null;
  maxScore: number | null;
  completedAt: string | null;
}
interface MgQuiz {
  quizId: string;
  meetingId: string;
  meetingTitle: string;
  questionCount: number;
  assignments: MgAssignment[];
}
interface ReviewQ { id: string; prompt: string; type: string; options: { id: string; text: string }[]; correctOptionIds: string[] }
interface Review {
  user: { name: string; email?: string | null } | null;
  status: string;
  score: number | null;
  maxScore: number | null;
  meetingTitle: string;
  questions: ReviewQ[];
  answers: Record<string, string[]>;
}

/** The comprehension-quizzes hub (My quizzes + Assigned by me). Rendered as a
 *  tab inside the Tasks page. */
export function QuizzesPanel() {
  const tr = useTranslations();
  const [mine, setMine] = useState<MyItem[]>([]);
  const [managed, setManaged] = useState<MgQuiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/quiz').then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/quizzes/managed').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
      .then(([m, g]) => {
        setMine(Array.isArray(m) ? m : []);
        setManaged(Array.isArray(g) ? g : []);
      })
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const deleteManaged = async (q: MgQuiz) => {
    if (!confirm(tr('quiz.deleteConfirm'))) return;
    try {
      const res = await fetch(`/api/meetings/${q.meetingId}/quiz`, { method: 'DELETE' });
      if (res.ok) setManaged((m) => m.filter((x) => x.quizId !== q.quizId));
    } catch {
      /* ignore */
    }
  };

  const openReview = useCallback(async (assignmentId: string) => {
    setReviewOpen(true);
    setReview(null);
    setReviewLoading(true);
    try {
      const res = await fetch(`/api/quiz/${assignmentId}/review`);
      setReview(res.ok ? await res.json() : null);
    } catch {
      setReview(null);
    } finally {
      setReviewLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
      </div>
    );
  }

  const empty = mine.length === 0 && managed.length === 0;

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '20px 16px 80px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {empty && (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
            <ClipboardList size={28} style={{ opacity: 0.4, margin: '0 auto 10px' }} />
            <div style={{ fontSize: 14 }}>{tr('quiz.noMine')}</div>
          </div>
        )}

        {/* My quizzes */}
        {mine.length > 0 && (
          <section>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>{tr('quiz.myQuizzes')}</h2>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {mine.map((it) => {
                const done = it.status === 'completed';
                return (
                  <Link key={it.id} href={`/quiz/${it.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                      <span style={{
                        width: 32, height: 32, flexShrink: 0, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: done ? 'color-mix(in oklab, var(--green) 16%, transparent)' : 'color-mix(in oklab, var(--accent) 16%, transparent)',
                        color: done ? 'var(--green)' : 'var(--accent)',
                      }}>
                        {done ? <Check size={16} /> : <ClipboardList size={16} />}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.meetingTitle}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          {done ? tr('quiz.completedLabel') : tr('quiz.questionsCount', { count: it.questionCount })}
                        </div>
                      </div>
                      {done ? (
                        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono, monospace)', color: 'var(--green)' }}>{it.score}/{it.maxScore}</span>
                      ) : (
                        <span className="btn btn-sm btn-primary">{tr('quiz.take')}</span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Assigned by me (admin / creator) */}
        {managed.length > 0 && (
          <section>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>{tr('quiz.tabManaged')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {managed.map((q) => {
                const open = expanded.has(q.quizId);
                const doneCount = q.assignments.filter((a) => a.status === 'completed').length;
                return (
                  <div key={q.quizId} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <button
                        onClick={() => toggle(q.quizId)}
                        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}
                      >
                        {open ? <ChevronDown size={16} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={16} style={{ color: 'var(--muted)' }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.meetingTitle}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{tr('quiz.progress', { done: doneCount, total: q.assignments.length })}</div>
                        </div>
                        <Users size={14} style={{ color: 'var(--muted)' }} />
                        <span style={{ fontSize: 12.5, color: 'var(--muted)', fontFamily: 'var(--mono, monospace)' }}>{q.assignments.length}</span>
                      </button>
                      <button onClick={() => deleteManaged(q)} title={tr('quiz.delete')} aria-label={tr('quiz.delete')}
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: '0 12px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {open && (
                      <div style={{ borderTop: '1px solid var(--border)' }}>
                        {q.assignments.map((a) => {
                          const adone = a.status === 'completed';
                          return (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 10px 36px', borderBottom: '1px solid var(--border)' }}>
                              <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {a.user?.name || a.user?.email || '—'}
                              </span>
                              {adone ? (
                                <>
                                  <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono, monospace)', color: 'var(--green)' }}>{a.score}/{a.maxScore}</span>
                                  <button className="btn btn-ghost btn-sm" onClick={() => openReview(a.id)} style={{ color: 'var(--accent)' }}>
                                    {tr('quiz.viewAnswers')}
                                  </button>
                                </>
                              ) : (
                                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('quiz.notTaken')}</span>
                              )}
                            </div>
                          );
                        })}
                        <Link href={`/meetings/${q.meetingId}/report`} style={{ display: 'block', padding: '9px 14px', fontSize: 12.5, color: 'var(--muted)', textDecoration: 'none', textAlign: 'center' }}>
                          {tr('quiz.openReport')} &rarr;
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Review modal (admin) */}
      <Modal open={reviewOpen} onClose={() => { setReviewOpen(false); setReview(null); }} title={review?.user?.name ? tr('quiz.reviewOf', { name: review.user.name }) : tr('quiz.viewAnswers')} width={640}>
        {reviewLoading || !review ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            {reviewLoading ? <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /> : <span style={{ color: 'var(--muted)', fontSize: 13 }}>{tr('quiz.loadError')}</span>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {review.meetingTitle} · <span style={{ color: 'var(--green)', fontWeight: 600 }}>{review.score}/{review.maxScore}</span>
            </div>
            {review.questions.map((q, qi) => {
              const sel = review.answers[q.id] || [];
              return (
                <div key={q.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{qi + 1}. {q.prompt}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {q.options.map((o) => {
                      const isCorrect = q.correctOptionIds.includes(o.id);
                      const picked = sel.includes(o.id);
                      let color = 'var(--text-2)';
                      let icon = null as React.ReactNode;
                      if (isCorrect) { color = 'var(--green)'; icon = <Check size={13} />; }
                      else if (picked) { color = 'var(--danger-fg)'; icon = <X size={13} />; }
                      return (
                        <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color }}>
                          <span style={{ width: 16, flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>{icon}</span>
                          <span style={{ fontWeight: picked ? 600 : 400 }}>{o.text}</span>
                          {picked && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>({tr('quiz.userPicked')})</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
