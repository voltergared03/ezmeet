"use client";

import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from "react";
import { useSession } from "next-auth/react";
import { useTranslations, useLocale } from "next-intl";
import { Select } from "@/components/ui/select";
import Link from "next/link";
import {
  ListChecks, Check, Clock, Search, X, Sparkles, ChevronDown, ArrowUp, ArrowDown,
  MoreHorizontal, User, Loader2, Plus, Trash2, Video,
  LayoutList, LayoutGrid, AlertCircle, Calendar as CalendarIcon, Wand2, Building2,
  MessageSquare, Paperclip, Send, Download, Users, UploadCloud, GitBranch, SlidersHorizontal,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useQuizPending } from "@/hooks/use-quiz-pending";
import { QuizzesPanel } from "../quizzes/quizzes-panel";
import { FieldCell } from "../database/components/FieldCell";
import { FieldEditor, type FieldDraft } from "../database/components/FieldEditor";
import { EDITABLE_CUSTOM_TYPES, customTaskFields, chipsForRow, filterableCustomFields, matchesCustomFilters } from "./custom-fields";
import type { FieldT, OrgMember } from "../database/lib/types";

/* ─── Types ─────────────────────────────────────────────── */
interface TaskAssignee { id: string; name: string | null; image: string | null; }
interface TaskMeeting { id: string; title: string; scheduledAt: string | null; }
interface Subtask {
  id: string; title: string; status: string; priority: string;
  dueDate: string | null; assigneeName: string | null; assignee: TaskAssignee | null;
  clickupManaged?: boolean; clickupUrl?: string | null;
  linearManaged?: boolean; linearUrl?: string | null;
}
interface Task {
  id: string; title: string; description?: string | null;
  priority: string; status: string; dueDate: string | null;
  assigneeName: string | null; meetingId: string; source?: string;
  assignee: TaskAssignee | null; meeting?: TaskMeeting;
  assigneeId?: string | null; completedAt?: string | null;
  departmentId?: string | null;
  // External two-way sync: when managed, this task is a read-only mirror (edits in ClickUp/Linear).
  clickupManaged?: boolean; clickupUrl?: string | null;
  linearManaged?: boolean; linearUrl?: string | null;
  department?: { id: string; name: string; color: string | null } | null;
  parentId?: string | null;
  collaborators?: { userId: string }[];
  assignees?: { user: TaskAssignee }[];
  subtasks?: Subtask[];
  /** Custom-field cell bag (P3.3), keyed by Field id — secrets already stripped server-side. */
  cells?: Record<string, unknown>;
  _count?: { subtasks: number; comments: number; attachments: number };
}
interface UserItem { id: string; name: string; email: string; image: string | null; }
interface MeetingOption { id: string; title: string; scheduledAt: string | null; }

/* ─── Due date helper ───────────────────────────────────── */
type DueInfo =
  | { kind: "today"; overdue: false; soon: true }
  | { kind: "tomorrow"; overdue: false; soon: true }
  | { kind: "overdue"; days: number; overdue: true; soon: false }
  | { kind: "weekday"; date: string; overdue: false; soon: boolean }
  | { kind: "date"; date: string; overdue: false; soon: false };

function dueInfo(d: string | null): DueInfo | null {
  if (!d) return null;
  const due = new Date(d); due.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return { kind: "today", overdue: false, soon: true };
  if (diff === 1) return { kind: "tomorrow", overdue: false, soon: true };
  if (diff < 0) return { kind: "overdue", days: -diff, overdue: true, soon: false };
  if (diff < 7) return { kind: "weekday", date: d, overdue: false, soon: diff < 3 };
  return { kind: "date", date: d, overdue: false, soon: false };
}

/** Resolve a localized due-date label. `tr`/`locale` come from the calling component. */
function dueText(due: DueInfo, tr: ReturnType<typeof useTranslations>, locale: string): string {
  switch (due.kind) {
    case "today": return tr("common.today");
    case "tomorrow": return tr("common.tomorrow");
    case "overdue": return tr("tasks.overdueDays", { count: due.days });
    case "weekday": return new Date(due.date).toLocaleDateString(locale, { weekday: "long" });
    case "date": return new Date(due.date).toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
}

/* ─── Highlight search matches ──────────────────────────── */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  try {
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return <>{parts.map((p, i) =>
      p.toLowerCase() === q.toLowerCase()
        ? <mark key={i} style={{ background: "color-mix(in oklab, var(--accent) 35%, transparent)", color: "var(--text)", padding: "0 2px", borderRadius: 3 }}>{p}</mark>
        : p
    )}</>;
  } catch { return <>{text}</>; }
}

/* ─── Status checkbox ───────────────────────────────────── */
/** Small "Managed in ClickUp/Linear" chip + link, shown on read-only (externally owned) tasks. */
function ManagedChip({ label, url }: { label: string; url?: string | null }) {
  const inner = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, lineHeight: 1.4, padding: "1px 7px", borderRadius: 6, background: "color-mix(in oklab, var(--accent) 14%, transparent)", color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
      {label}{url ? " ↗" : ""}
    </span>
  );
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`Managed in ${label}`} style={{ textDecoration: "none" }}>{inner}</a>
    : inner;
}
/** A task is externally owned (read-only mirror) if managed by ClickUp OR Linear. */
function managedOf(t: { clickupManaged?: boolean; clickupUrl?: string | null; linearManaged?: boolean; linearUrl?: string | null }): { managed: boolean; label: string; url: string | null } {
  if (t.linearManaged) return { managed: true, label: "Linear", url: t.linearUrl ?? null };
  if (t.clickupManaged) return { managed: true, label: "ClickUp", url: t.clickupUrl ?? null };
  return { managed: false, label: "", url: null };
}

function StatusCheckbox({ status, onClick }: { status: string; onClick: (e: React.MouseEvent) => void }) {
  const bg = status === "done" ? "var(--green)" : "transparent";
  const border = status === "done" ? "var(--green)" : status === "in_progress" ? "var(--amber)" : "var(--border)";
  return (
    <button onClick={onClick} title={status} style={{
      width: 20, height: 20, borderRadius: 6, flexShrink: 0, cursor: "pointer",
      background: bg, border: `1.5px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "center",
      color: "#fff", transition: "all .15s", padding: 0,
    }}>
      {status === "done" && <Check size={13} strokeWidth={3} />}
      {status === "in_progress" && <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--amber)" }} />}
    </button>
  );
}

/* ─── Priority indicators ───────────────────────────────── */
function PriorityDot({ p, size = 7 }: { p: string; size?: number }) {
  const c = p === "high" ? "var(--red)" : p === "medium" ? "var(--amber)" : "var(--muted)";
  return <span style={{ width: size, height: size, borderRadius: "50%", background: c, flexShrink: 0, display: "inline-block" }} />;
}
function PriorityTag({ p }: { p: string }) {
  const tr = useTranslations();
  const map: Record<string, { c: string; l: string }> = {
    high: { c: "var(--red)", l: tr("tasks.priorityShortHigh") },
    medium: { c: "var(--amber)", l: tr("tasks.priorityShortMedium") },
    low: { c: "var(--muted)", l: tr("tasks.priorityShortLow") },
  };
  const v = map[p] || map.medium;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, padding: "2px 7px",
      borderRadius: 5, background: `color-mix(in oklab, ${v.c} 14%, transparent)`, color: v.c, fontWeight: 600 }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: v.c }} />{v.l}
    </span>
  );
}

/* ─── Filter Pills ──────────────────────────────────────── */
function DeptChip({ dept }: { dept?: { id: string; name: string; color: string | null } | null }) {
  if (!dept) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "2px 8px", borderRadius: 999,
      background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-2)", whiteSpace: "nowrap", flexShrink: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: dept.color || "var(--accent)", flexShrink: 0 }} />
      {dept.name}
    </span>
  );
}

function CountBadges({ c }: { c?: { subtasks: number; comments: number; attachments: number } }) {
  if (!c) return null;
  const items = [
    c.comments > 0 ? { icon: MessageSquare, n: c.comments } : null,
    c.attachments > 0 ? { icon: Paperclip, n: c.attachments } : null,
  ].filter(Boolean) as { icon: React.ComponentType<{ size?: number }>; n: number }[];
  if (items.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--muted)" }}>
            <Icon size={11} /> {it.n}
          </span>
        );
      })}
    </span>
  );
}

function FilterPills({ value, onChange, options }: {
  value: string; onChange: (v: string) => void;
  options: { id: string; label: string; count: number }[];
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map(o => {
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} className="btn btn-sm" style={{
            background: active ? "color-mix(in oklab, var(--accent) 18%, transparent)" : "var(--surface)",
            border: "1px solid " + (active ? "color-mix(in oklab, var(--accent) 40%, transparent)" : "var(--border)"),
            color: active ? "#bfdbfe" : "var(--text-2)", fontWeight: active ? 600 : 500,
          }}>
            {o.label}
            <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11, fontFamily: "var(--font-mono, monospace)" }}>{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── Select chip ───────────────────────────────────────── */
function SelectChip({ value, onChange, options, icon: IconComp }: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
  icon: React.ElementType;
}) {
  const isActive = value !== "all";
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      icon={<IconComp size={13} style={{ color: isActive ? "#bfdbfe" : "var(--muted)", flexShrink: 0 }} />}
      style={{
        height: 34,
        width: "auto",
        fontSize: 13,
        borderRadius: 8,
        background: "var(--surface)",
        border: "1px solid " + (isActive ? "color-mix(in oklab, var(--accent) 35%, transparent)" : "var(--border)"),
        color: isActive ? "#bfdbfe" : "var(--text-2)",
      }}
    />
  );
}

/* Compact read-only chips for non-empty CUSTOM fields, shown on board rows/cards
   so values are visible without opening the drawer. Only editable-typed fields
   are chipped (never totp/password — a live code must not surface on the board). */
function CustomFieldChips({ fields, cells, members, max = 3 }: {
  fields: FieldT[]; cells?: Record<string, unknown>; members: OrgMember[]; max?: number;
}) {
  const shown = chipsForRow(fields, cells, members, max);
  if (!shown.length) return null;
  return (
    <>
      {shown.map(c => (
        <span key={c.name} title={`${c.name}: ${c.text}`} style={{
          display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 7px", borderRadius: 5,
          background: "var(--surface-2)", color: "var(--text-2)", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
        }}>
          <span style={{ color: "var(--muted)" }}>{c.name}:</span> {c.text}
        </span>
      ))}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   TASK ROW (List view)
   ═══════════════════════════════════════════════════════════ */
function TaskRow({ t, onEdit, onStatusChange, q, last, mobile, expanded, onToggleExpand, customFields = [], members = [] }: {
  t: Task; onEdit: () => void; onStatusChange: (status: string) => void;
  q: string; last: boolean; mobile?: boolean;
  expanded?: boolean; onToggleExpand?: () => void;
  customFields?: FieldT[]; members?: OrgMember[];
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const due = dueInfo(t.dueDate);
  const isOverdue = due?.overdue && t.status !== "done";
  const subTotal = t.subtasks?.length ?? t._count?.subtasks ?? 0;
  const subDone = t.subtasks?.filter(s => s.status === "done").length ?? 0;

  const cycleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = t.status === "open" ? "in_progress" : t.status === "in_progress" ? "done" : "open";
    onStatusChange(next);
  };

  // Disclosure caret — always present (so any task can get a first subtask
  // inline), brighter when subtasks exist. Rotates ▸→▾ when open.
  const caret = (
    <button onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
      aria-label={expanded ? tr("tasks.hide") : tr("tasks.show")}
      style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", color: "var(--muted)", flexShrink: 0 }}>
      <ChevronDown size={15} style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform .15s", opacity: subTotal > 0 ? 0.95 : 0.4 }} />
    </button>
  );

  // Mobile: a stacked card — title on top, then a wrapping meta row. Far more
  // legible on a phone than the desktop single-line row.
  if (mobile) {
    const dueChip = due && (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 8px", borderRadius: 6,
        background: isOverdue ? "color-mix(in oklab, var(--red) 18%, transparent)" :
                    due.soon ? "color-mix(in oklab, var(--amber) 14%, transparent)" : "var(--surface-2)",
        color: isOverdue ? "#fca5a5" : due.soon ? "#fcd34d" : "var(--text-2)",
        fontWeight: isOverdue ? 600 : 500,
      }}>
        <Clock size={11} /> {dueText(due, tr, locale)}
      </span>
    );
    return (
      <div onClick={onEdit} style={{
        display: "flex", gap: 12, padding: "13px 16px",
        borderBottom: last ? "none" : "1px solid var(--border)",
        borderLeft: isOverdue ? "3px solid var(--red)" : "3px solid transparent",
        paddingLeft: isOverdue ? 13 : 16, cursor: "pointer",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2, paddingTop: 1, flexShrink: 0 }}>
          {caret}
          <StatusCheckbox status={t.status} onClick={cycleStatus} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
            {t.source === "ai" && <Sparkles size={12} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 3 }} />}
            <div style={{
              fontSize: 14, fontWeight: 500, lineHeight: 1.35, flex: 1, minWidth: 0,
              color: t.status === "done" ? "var(--muted)" : "var(--text)",
              textDecoration: t.status === "done" ? "line-through" : "none",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
            }}>
              <Hl text={t.title} q={q} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <PriorityTag p={t.priority} />
            {dueChip}
            <DeptChip dept={t.department} />
            <SubProgress done={subDone} total={subTotal} />
            <CountBadges c={t._count} />
            <CustomFieldChips fields={customFields} cells={t.cells} members={members} max={2} />
            {t.assignee ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--muted)", marginLeft: "auto" }}>
                <Avatar name={t.assignee.name || "?"} image={t.assignee.image} size="sm" />
                {(t.assignee.name || "").split(" ")[0]}
              </span>
            ) : t.assigneeName ? (
              <span style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: "auto" }}>{t.assigneeName}</span>
            ) : null}
          </div>
          {t.meeting && t.meetingId && (
            <Link href={`/meetings/${t.meetingId}/report`} onClick={e => e.stopPropagation()} style={{
              display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted)", textDecoration: "none",
              fontSize: 11.5, marginTop: 8, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              <Video size={11} /> {t.meeting.title}
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14, padding: "12px 16px",
      borderBottom: last ? "none" : "1px solid var(--border)",
      borderLeft: isOverdue ? "3px solid var(--red)" : "3px solid transparent",
      paddingLeft: isOverdue ? 13 : 16, transition: "background .15s", cursor: "pointer",
    }}
      onClick={onEdit}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {caret}
        <StatusCheckbox status={t.status} onClick={cycleStatus} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          {t.source === "ai" && <Sparkles size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />}
          <div style={{
            fontSize: 13.5, fontWeight: 500,
            color: t.status === "done" ? "var(--muted)" : "var(--text)",
            textDecoration: t.status === "done" ? "line-through" : "none",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
          }}>
            <Hl text={t.title} q={q} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--muted)", overflow: "hidden" }}>
          {t.meeting && t.meetingId ? (
            <Link href={`/meetings/${t.meetingId}/report`} onClick={e => e.stopPropagation()} style={{
              display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted)", textDecoration: "none",
              fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260,
            }}>
              <Video size={11} /> {t.meeting.title}
            </Link>
          ) : !t.meetingId ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted)", fontSize: 11.5 }}>
              <ListChecks size={11} /> {tr("tasks.standaloneTask")}
            </span>
          ) : null}
          <DeptChip dept={t.department} />
          <SubProgress done={subDone} total={subTotal} />
          <CountBadges c={t._count} />
          <CustomFieldChips fields={customFields} cells={t.cells} members={members} max={3} />
        </div>
      </div>
      <PriorityTag p={t.priority} />
      {t.assignee ? (
        <div title={t.assignee.name || ""} style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 160, flexShrink: 0 }}>
          <Avatar name={t.assignee.name || "?"} image={t.assignee.image} size="sm" />
          <span style={{ fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.assignee.name}</span>
        </div>
      ) : t.assigneeName ? (
        <span title={t.assigneeName} style={{ fontSize: 12, color: "var(--muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{t.assigneeName}</span>
      ) : null}
      <div style={{ minWidth: 108, textAlign: "right" }}>
        {due && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 8px", borderRadius: 6,
            background: isOverdue ? "color-mix(in oklab, var(--red) 18%, transparent)" :
                        due.soon ? "color-mix(in oklab, var(--amber) 14%, transparent)" : "var(--surface-2)",
            color: isOverdue ? "#fca5a5" : due.soon ? "#fcd34d" : "var(--text-2)",
            fontWeight: isOverdue ? 600 : 500,
          }}>
            <Clock size={11} /> {dueText(due, tr, locale)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Subtask progress meter (parent row) ──────────────────── */
function SubProgress({ done, total }: { done: number; total: number }) {
  if (total <= 0) return null;
  const pct = Math.round((done / total) * 100);
  const complete = done === total;
  return (
    <span title={`${done}/${total}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <span style={{ position: "relative", width: 34, height: 4, borderRadius: 3, background: "var(--surface-2, #2a2a32)", overflow: "hidden" }}>
        <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: complete ? "var(--green)" : "var(--accent)", borderRadius: 3, transition: "width .25s ease" }} />
      </span>
      <span style={{ fontSize: 11, color: complete ? "var(--green)" : "var(--muted)", fontFamily: "var(--font-mono, monospace)" }}>{done}/{total}</span>
    </span>
  );
}

/* ─── Inline subtask list (expanded under a parent row) ─────── */
function SubtaskList({ parent, mobile, onOpen, onChange }: {
  parent: Task; mobile?: boolean; onOpen: (id: string) => void; onChange: (next: Subtask[]) => void;
}) {
  const tr = useTranslations();
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const subs = parent.subtasks || [];

  const toggle = async (s: Subtask, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = s.status === "done" ? "open" : "done";
    const prev = subs;
    onChange(subs.map(x => x.id === s.id ? { ...x, status: next } : x));
    try {
      const res = await fetch("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: s.id, status: next }) });
      if (!res.ok) onChange(prev); // revert on failure instead of silently diverging
    } catch { onChange(prev); }
  };
  const del = (s: Subtask, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(subs.filter(x => x.id !== s.id));
    fetch("/api/tasks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: s.id }) }).catch(() => {});
  };
  const add = async () => {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true); setNewTitle("");
    try {
      const r = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, parentId: parent.id }) });
      if (r.ok) {
        const c = await r.json();
        onChange([...subs, { id: c.id, title: c.title, status: c.status, priority: c.priority, dueDate: c.dueDate, assigneeName: c.assigneeName ?? null, assignee: c.assignee ?? null }]);
      }
    } finally { setAdding(false); }
  };

  return (
    <div style={{
      paddingLeft: mobile ? 34 : 48, paddingRight: mobile ? 14 : 16, paddingTop: 4, paddingBottom: 10,
      background: "color-mix(in oklab, var(--accent) 4%, var(--surface))",
      borderBottom: "1px solid var(--border)", animation: "subIn .16s ease",
    }}>
      {subs.map(s => {
        const done = s.status === "done";
        return (
          <div key={s.id} onClick={() => onOpen(s.id)} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "6px 6px 6px 12px", cursor: "pointer",
            borderLeft: "2px solid var(--border)", borderRadius: "0 7px 7px 0",
          }}
            onMouseEnter={e => (e.currentTarget.style.background = "color-mix(in oklab, var(--accent) 8%, transparent)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
            <StatusCheckbox status={s.status} onClick={(e) => toggle(s, e)} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: done ? "var(--muted)" : "var(--text-2)", textDecoration: done ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
            {s.assignee ? <Avatar name={s.assignee.name || "?"} image={s.assignee.image} size="sm" />
              : s.assigneeName ? <span style={{ fontSize: 11, color: "var(--muted)" }}>{s.assigneeName.split(" ")[0]}</span> : null}
            <button onClick={(e) => del(s, e)} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 2, display: "flex", flexShrink: 0 }}><Trash2 size={13} /></button>
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, marginTop: subs.length ? 4 : 0 }}>
        <Plus size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
        <input value={newTitle} onChange={e => setNewTitle(e.target.value)} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter") add(); }}
          placeholder={tr("tasks.subtaskPlaceholder")}
          style={{ flex: 1, height: 30, padding: "0 10px", fontSize: 12.5, borderRadius: 7, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
        {adding && <Loader2 size={13} className="spin" style={{ color: "var(--muted)" }} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LIST VIEW  (desktop = dense sortable table · mobile = stacked cards)
   ═══════════════════════════════════════════════════════════ */
type SortKey = "title" | "priority" | "assignee" | "due" | "progress" | "dept" | "state";
const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STATE_RANK: Record<string, number> = { open: 0, in_progress: 1, done: 2 };
function dueRank(d: string | null): number {
  if (!d) return Number.POSITIVE_INFINITY; // tasks with no due date sort last
  const t = new Date(d); t.setHours(0, 0, 0, 0); return t.getTime();
}
function progPct(t: Task): number {
  const total = t.subtasks?.length ?? t._count?.subtasks ?? 0;
  if (total <= 0) return -1; // "no subtasks" sorts below 0%
  return (t.subtasks?.filter(s => s.status === "done").length ?? 0) / total;
}
function cmpTasks(a: Task, b: Task, key: SortKey): number {
  switch (key) {
    case "title": return a.title.localeCompare(b.title);
    case "priority": return (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1);
    case "assignee": return (a.assignee?.name || a.assigneeName || "￿").localeCompare(b.assignee?.name || b.assigneeName || "￿");
    case "due": return dueRank(a.dueDate) - dueRank(b.dueDate);
    case "progress": return progPct(b) - progPct(a); // base order: most complete first
    case "dept": return (a.department?.name || "￿").localeCompare(b.department?.name || "￿");
    case "state": return (STATE_RANK[a.status] ?? 0) - (STATE_RANK[b.status] ?? 0);
  }
}

/* Small status pill (used in the Status column of the by-department table). */
function StateChip({ status }: { status: string }) {
  const tr = useTranslations();
  const map: Record<string, { c: string; l: string }> = {
    open: { c: "var(--accent)", l: tr("tasks.statusOpen") },
    in_progress: { c: "var(--amber)", l: tr("tasks.statusInProgress") },
    done: { c: "var(--green)", l: tr("tasks.statusDone") },
  };
  const v = map[status] || map.open;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "2px 8px", borderRadius: 999,
      background: `color-mix(in oklab, ${v.c} 14%, transparent)`, color: v.c, fontWeight: 600, whiteSpace: "nowrap" }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: v.c }} />{v.l}
    </span>
  );
}

const Dash = () => <span style={{ color: "var(--border-2, #3f3f46)", fontSize: 12 }}>—</span>;

/* One desktop table row — aligns to the shared `cols` grid template. */
function TaskTableRow({ t, cols, onEdit, onStatusChange, q, expanded, onToggleExpand, customFields, members, showDept, showState }: {
  t: Task; cols: string; onEdit: () => void; onStatusChange: (s: string) => void;
  q: string; expanded: boolean; onToggleExpand: () => void;
  customFields: FieldT[]; members: OrgMember[]; showDept: boolean; showState: boolean;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const due = dueInfo(t.dueDate);
  const isOverdue = due?.overdue && t.status !== "done";
  const isDone = t.status === "done";
  const subTotal = t.subtasks?.length ?? t._count?.subtasks ?? 0;
  const subDone = t.subtasks?.filter(s => s.status === "done").length ?? 0;
  const cycle = (e: React.MouseEvent) => { e.stopPropagation(); onStatusChange(t.status === "open" ? "in_progress" : t.status === "in_progress" ? "done" : "open"); };
  const showSubtitle = !!(t.meeting && t.meetingId) || (!t.meetingId) || (!!t.cells && customFields.length > 0);
  return (
    <div role="row" onClick={onEdit}
      style={{
        display: "grid", gridTemplateColumns: cols, alignItems: "center", columnGap: 12,
        padding: "0 14px", minHeight: 46, borderBottom: "1px solid var(--border)",
        borderLeft: isOverdue ? "2px solid var(--red)" : "2px solid transparent",
        cursor: "pointer", transition: "background .12s",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      {/* disclosure + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }} aria-label={expanded ? tr("tasks.hide") : tr("tasks.show")}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", color: "var(--muted)" }}>
          <ChevronDown size={14} style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform .15s", opacity: subTotal > 0 ? 0.9 : 0.3 }} />
        </button>
        <StatusCheckbox status={t.status} onClick={cycle} />
      </div>
      {/* title (+ subtitle: meeting source / custom chips) */}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2, paddingRight: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {t.source === "ai" && <Sparkles size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />}
          <span style={{ fontSize: 13.5, fontWeight: 500, color: isDone ? "var(--muted)" : "var(--text)",
            textDecoration: isDone ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <Hl text={t.title} q={q} />
          </span>
          {(t.clickupManaged || t.linearManaged) && <ManagedChip label={t.linearManaged ? "Linear" : "ClickUp"} url={t.linearManaged ? t.linearUrl : t.clickupUrl} />}
        </div>
        {showSubtitle && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
            {t.meeting && t.meetingId ? (
              <Link href={`/meetings/${t.meetingId}/report`} onClick={e => e.stopPropagation()} style={{
                display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted)", textDecoration: "none",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280, flexShrink: 1 }}>
                <Video size={10} style={{ flexShrink: 0 }} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.meeting.title}</span>
              </Link>
            ) : !t.meetingId ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}><ListChecks size={10} /> {tr("tasks.standaloneTask")}</span>
            ) : null}
            <CustomFieldChips fields={customFields} cells={t.cells} members={members} max={2} />
          </div>
        )}
      </div>
      {/* priority */}
      <div style={{ minWidth: 0 }}><PriorityTag p={t.priority} /></div>
      {/* assignee */}
      <div style={{ minWidth: 0 }}>
        {t.assignee ? (
          <span title={t.assignee.name || ""} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
            <Avatar name={t.assignee.name || "?"} image={t.assignee.image} size="sm" />
            <span style={{ fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.assignee.name}</span>
          </span>
        ) : t.assigneeName ? (
          <span title={t.assigneeName} style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{t.assigneeName}</span>
        ) : <Dash />}
      </div>
      {/* due */}
      <div style={{ minWidth: 0 }}>
        {due ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 8px", borderRadius: 6, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
            background: isOverdue ? "color-mix(in oklab, var(--red) 18%, transparent)" : due.soon ? "color-mix(in oklab, var(--amber) 14%, transparent)" : "var(--surface-2)",
            color: isOverdue ? "#fca5a5" : due.soon ? "#fcd34d" : "var(--text-2)", fontWeight: isOverdue ? 600 : 500 }}>
            <Clock size={11} /> {dueText(due, tr, locale)}
          </span>
        ) : <Dash />}
      </div>
      {/* progress */}
      <div style={{ minWidth: 0 }}>{subTotal > 0 ? <SubProgress done={subDone} total={subTotal} /> : <Dash />}</div>
      {/* dept (status grouping) */}
      {showDept && <div style={{ minWidth: 0 }}>{t.department ? <DeptChip dept={t.department} /> : <Dash />}</div>}
      {/* status (department grouping) */}
      {showState && <div style={{ minWidth: 0 }}><StateChip status={t.status} /></div>}
    </div>
  );
}

/* Inline quick-add at the foot of a group. */
function QuickAddRow({ cols, placeholder, onCreate }: { cols: string; placeholder: string; onCreate: (title: string) => Promise<void> | void }) {
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = val.trim(); if (!v || busy) return;
    setBusy(true); try { await onCreate(v); setVal(""); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", columnGap: 12, padding: "0 14px", minHeight: 40, borderLeft: "2px solid transparent" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: 2, color: "var(--muted)" }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />}
      </div>
      <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder={placeholder}
        style={{ background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 13, width: "100%", padding: "10px 0" }} />
    </div>
  );
}

function TaskListView({ tasks, onEdit, onStatusChange, q, mobile, groupBy = "status", departments = [], onOpenById, onSubtaskChange, onQuickCreate, customFields = [], members = [] }: {
  tasks: Task[]; onEdit: (t: Task) => void; onStatusChange: (id: string, s: string) => void; q: string; mobile?: boolean;
  groupBy?: "status" | "department"; departments?: { id: string; name: string; color: string | null }[];
  onOpenById?: (id: string) => void; onSubtaskChange?: (parentId: string, next: Subtask[]) => void;
  onQuickCreate?: (opts: { title: string; status?: string; departmentId?: string | null }) => void | Promise<void>;
  customFields?: FieldT[]; members?: OrgMember[];
}) {
  const tr = useTranslations();
  const [collapsedDone, setCollapsedDone] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const toggleExpand = (id: string) => setExpanded(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleSort = (key: SortKey) => setSort(prev => prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });

  const { order, groups, meta } = useMemo(() => {
    if (groupBy === "department") {
      const order = [...departments.map(d => d.id), "__none__"];
      const groups: Record<string, Task[]> = {};
      const meta: Record<string, { label: string; color: string }> = {};
      for (const d of departments) { groups[d.id] = []; meta[d.id] = { label: d.name, color: d.color || "var(--accent)" }; }
      groups.__none__ = []; meta.__none__ = { label: tr("departments.none"), color: "var(--muted)" };
      for (const t of tasks) {
        const key = t.departmentId && groups[t.departmentId] ? t.departmentId : "__none__";
        groups[key].push(t);
      }
      return { order, groups, meta };
    }
    return {
      order: ["open", "in_progress", "done"],
      groups: {
        open: tasks.filter(t => t.status === "open"),
        in_progress: tasks.filter(t => t.status === "in_progress"),
        done: tasks.filter(t => t.status === "done"),
      } as Record<string, Task[]>,
      meta: {
        open: { label: tr("tasks.statusOpen"), color: "var(--accent)" },
        in_progress: { label: tr("tasks.statusInProgress"), color: "var(--amber)" },
        done: { label: tr("tasks.statusDone"), color: "var(--green)" },
      } as Record<string, { label: string; color: string }>,
    };
  }, [tasks, groupBy, departments, tr]);

  const itemsFor = (key: string) => {
    const base = groups[key] || [];
    if (!sort) return base;
    const sorted = [...base].sort((a, b) => cmpTasks(a, b, sort.key));
    return sort.dir === "asc" ? sorted : sorted.reverse();
  };

  /* ── Mobile: stacked cards (unchanged) ─────────────────────────── */
  if (mobile) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "16px clamp(12px, 4vw, 20px) calc(96px + env(safe-area-inset-bottom, 0px))" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {order.map(key => {
            const items = itemsFor(key);
            if (!items.length) return null;
            const m = meta[key];
            const collapsible = groupBy === "status" && key === "done";
            const collapsed = collapsible && collapsedDone;
            const square = groupBy === "department";
            return (
              <section key={key}>
                <button onClick={() => { if (collapsible) setCollapsedDone(c => !c); }} disabled={!collapsible}
                  style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, background: "transparent", border: "none", padding: 0, cursor: collapsible ? "pointer" : "default", color: "inherit", width: "100%" }}>
                  <span style={{ width: square ? 9 : 6, height: square ? 9 : 6, borderRadius: square ? 3 : "50%", background: m.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", textTransform: "uppercase", letterSpacing: ".06em" }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--surface)", padding: "2px 7px", borderRadius: 5, fontFamily: "var(--font-mono, monospace)" }}>{items.length}</span>
                  <div style={{ flex: 1, height: 1, background: "var(--border)", marginLeft: 6 }} />
                  {collapsible && (
                    <span style={{ color: "var(--muted)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 4 }}>
                      {collapsed ? tr("tasks.show") : tr("tasks.hide")}
                      <ChevronDown size={13} style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .15s" }} />
                    </span>
                  )}
                </button>
                {!collapsed && (
                  <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
                    {items.map((t, i) => (
                      <Fragment key={t.id}>
                        <TaskRow t={t} onEdit={() => onEdit(t)} onStatusChange={(s) => onStatusChange(t.id, s)} q={q} last={i === items.length - 1} mobile
                          expanded={expanded.has(t.id)} onToggleExpand={() => toggleExpand(t.id)} customFields={customFields} members={members} />
                        {expanded.has(t.id) && (
                          <SubtaskList parent={t} mobile onOpen={(id) => onOpenById?.(id)} onChange={(next) => onSubtaskChange?.(t.id, next)} />
                        )}
                      </Fragment>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Desktop: dense, sortable table ────────────────────────────── */
  const showDept = groupBy === "status" && departments.length > 0;
  const showState = groupBy === "department";
  const colDefs: { key: SortKey | "_check"; label: string; width: string; sortable: boolean }[] = [
    { key: "_check", label: "", width: "44px", sortable: false },
    { key: "title", label: tr("tasks.colTitle"), width: "minmax(0,1fr)", sortable: true },
    { key: "priority", label: tr("tasks.colPriority"), width: "120px", sortable: true },
    { key: "assignee", label: tr("tasks.colAssignee"), width: "156px", sortable: true },
    { key: "due", label: tr("tasks.colDue"), width: "126px", sortable: true },
    { key: "progress", label: tr("tasks.colProgress"), width: "92px", sortable: true },
    ...(showDept ? [{ key: "dept" as const, label: tr("tasks.colDept"), width: "138px", sortable: true }] : []),
    ...(showState ? [{ key: "state" as const, label: tr("tasks.colStatus"), width: "132px", sortable: true }] : []),
  ];
  const cols = colDefs.map(c => c.width).join(" ");

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "18px clamp(14px, 4vw, 28px) 60px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
          {/* column header */}
          <div role="row" style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", columnGap: 12, padding: "0 14px", height: 38,
            borderBottom: "1px solid var(--border)", borderLeft: "2px solid transparent", background: "var(--bg, #0f1117)" }}>
            {colDefs.map(c => {
              const active = sort?.key === c.key;
              if (!c.sortable) return <div key={c.key} />;
              return (
                <div key={c.key} style={{ minWidth: 0 }}>
                  <button onClick={() => toggleSort(c.key as SortKey)} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer",
                    fontSize: 10.5, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: active ? "var(--text)" : "var(--muted)", transition: "color .12s" }}>
                    {c.label}
                    {active && (sort!.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                </div>
              );
            })}
          </div>

          {order.map(key => {
            const items = itemsFor(key);
            if (!items.length) return null;
            const m = meta[key];
            const collapsible = groupBy === "status" && key === "done";
            const collapsed = collapsible && collapsedDone;
            const square = groupBy === "department";
            const create = onQuickCreate && (groupBy === "status"
              ? (title: string) => onQuickCreate({ title, status: key })
              : (title: string) => onQuickCreate({ title, departmentId: key === "__none__" ? null : key }));
            return (
              <Fragment key={key}>
                {/* group separator band */}
                <button onClick={() => { if (collapsible) setCollapsedDone(c => !c); }} disabled={!collapsible}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px", background: "var(--bg, #0f1117)",
                    borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", borderLeft: "2px solid transparent",
                    cursor: collapsible ? "pointer" : "default", color: "inherit" }}>
                  <span style={{ width: square ? 9 : 6, height: square ? 9 : 6, borderRadius: square ? 3 : "50%", background: m.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: ".06em" }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--surface)", padding: "1px 7px", borderRadius: 5, fontFamily: "var(--font-mono, monospace)" }}>{items.length}</span>
                  {collapsible && (
                    <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 4 }}>
                      {collapsed ? tr("tasks.show") : tr("tasks.hide")}
                      <ChevronDown size={13} style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .15s" }} />
                    </span>
                  )}
                </button>
                {!collapsed && items.map(t => (
                  <Fragment key={t.id}>
                    <TaskTableRow t={t} cols={cols} onEdit={() => onEdit(t)} onStatusChange={(s) => onStatusChange(t.id, s)} q={q}
                      expanded={expanded.has(t.id)} onToggleExpand={() => toggleExpand(t.id)} customFields={customFields} members={members}
                      showDept={showDept} showState={showState} />
                    {expanded.has(t.id) && (
                      <SubtaskList parent={t} onOpen={(id) => onOpenById?.(id)} onChange={(next) => onSubtaskChange?.(t.id, next)} />
                    )}
                  </Fragment>
                ))}
                {!collapsed && create && !sort && (
                  <QuickAddRow cols={cols} placeholder={tr("tasks.quickAddPlaceholder")} onCreate={create} />
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   KANBAN VIEW
   ═══════════════════════════════════════════════════════════ */
function KanbanCard({ t, onEdit, onDragStart, dragging, customFields = [], members = [] }: {
  t: Task; onEdit: () => void; onDragStart: () => void; dragging: boolean;
  customFields?: FieldT[]; members?: OrgMember[];
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const due = dueInfo(t.dueDate);
  const isOverdue = due?.overdue && t.status !== "done";
  const isDone = t.status === "done";

  return (
    <div draggable={!(t.clickupManaged || t.linearManaged)} onDragStart={onDragStart} onClick={onEdit}
      style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderLeft: isOverdue ? "3px solid var(--red)" : "1px solid var(--border)",
        borderRadius: 10, padding: "12px 12px 10px", cursor: "pointer",
        opacity: dragging ? 0.4 : isDone ? 0.7 : 1, transition: "border-color .15s, transform .1s",
        userSelect: "none",
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-2, #3f3f46)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "none"; }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <PriorityDot p={t.priority} size={8} />
        {t.source === "ai" && <Sparkles size={11} style={{ color: "var(--accent)", marginTop: 2 }} />}
        <div style={{
          fontSize: 13, lineHeight: 1.4, fontWeight: 500, flex: 1, minWidth: 0,
          color: isDone ? "var(--muted)" : "var(--text)",
          textDecoration: isDone ? "line-through" : "none",
        }}>{t.title}</div>
        {(t.clickupManaged || t.linearManaged) && <ManagedChip label={t.linearManaged ? "Linear" : "ClickUp"} url={t.linearManaged ? t.linearUrl : t.clickupUrl} />}
      </div>
      {t.meeting && t.meetingId ? (
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11.5, marginBottom: 10,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <Video size={11} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.meeting.title}</span>
        </div>
      ) : !t.meetingId ? (
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11.5, marginBottom: 10 }}>
          <ListChecks size={11} /> {tr("tasks.standaloneTask")}
        </div>
      ) : null}
      {customFields.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          <CustomFieldChips fields={customFields} cells={t.cells} members={members} max={3} />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {t.assignee ? <Avatar name={t.assignee.name || "?"} image={t.assignee.image} size="sm" /> : <span />}
        {due && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 7px", borderRadius: 5,
            background: isOverdue ? "color-mix(in oklab, var(--red) 18%, transparent)" :
                        due.soon ? "color-mix(in oklab, var(--amber) 14%, transparent)" : "transparent",
            color: isOverdue ? "#fca5a5" : due.soon ? "#fcd34d" : "var(--muted)",
            fontWeight: isOverdue ? 600 : 500,
          }}>
            <Clock size={10} /> {dueText(due, tr, locale)}
          </span>
        )}
      </div>
    </div>
  );
}

function KanbanView({ tasks, onEdit, onStatusChange, customFields = [], members = [] }: {
  tasks: Task[]; onEdit: (t: Task) => void; onStatusChange: (id: string, s: string) => void;
  customFields?: FieldT[]; members?: OrgMember[];
}) {
  const tr = useTranslations();
  const cols = [
    { id: "open", label: tr("tasks.statusOpen"), color: "var(--accent)" },
    { id: "in_progress", label: tr("tasks.statusInProgress"), color: "var(--amber)" },
    { id: "done", label: tr("tasks.statusDone"), color: "var(--green)" },
  ];
  const grouped = useMemo(() => Object.fromEntries(cols.map(c => [c.id, tasks.filter(t => t.status === c.id)])), [tasks]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<string | null>(null);

  const onDrop = (colId: string) => {
    if (!dragId) return;
    const t = tasks.find(x => x.id === dragId);
    if (t && t.status !== colId) onStatusChange(t.id, colId);
    setDragId(null); setHoverCol(null);
  };

  return (
    <div style={{ flex: 1, overflowX: "auto", overflowY: "hidden", padding: "18px clamp(14px, 4vw, 28px) 28px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(260px, 1fr))", gap: 14, height: "100%", minWidth: 840 }}>
        {cols.map(col => (
          <div key={col.id} style={{
            display: "flex", flexDirection: "column", minHeight: 0,
            background: "var(--bg, #0f1117)", border: "1px solid " + (hoverCol === col.id ? "color-mix(in oklab, var(--accent) 45%, var(--border))" : "var(--border)"),
            borderRadius: 14, padding: "14px", transition: "border-color .15s",
          }}
            onDragOver={e => { e.preventDefault(); setHoverCol(col.id); }}
            onDragLeave={() => setHoverCol(c => c === col.id ? null : c)}
            onDrop={() => onDrop(col.id)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "2px 4px" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: col.color }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{col.label}</span>
              <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--surface)", padding: "2px 7px", borderRadius: 5, fontFamily: "var(--font-mono, monospace)" }}>
                {(grouped[col.id] || []).length}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4, paddingBottom: 14 }}>
              {(grouped[col.id] || []).length === 0 ? (
                <div style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: "24px 14px", textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>
                  {tr("tasks.dropTaskHere")}
                </div>
              ) : (grouped[col.id] || []).map(t => (
                <KanbanCard key={t.id} t={t} onEdit={() => onEdit(t)}
                  onDragStart={() => setDragId(t.id)} dragging={dragId === t.id}
                  customFields={customFields} members={members} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════════ */
function EmptyState({ scope, q, onCreate }: { scope: string; q: string; onCreate: () => void }) {
  const tr = useTranslations();
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ textAlign: "center", maxWidth: 380 }}>
        <div style={{ width: 88, height: 88, borderRadius: "50%", background: "var(--surface)", border: "1px dashed var(--border)",
          display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
          <ListChecks size={36} style={{ color: "var(--muted)" }} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6, letterSpacing: "-0.01em" }}>
          {q ? tr("tasks.emptyNoResultsTitle") : scope === "mine" ? tr("tasks.emptyMineTitle") : tr("tasks.emptyAllTitle")}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.55, marginBottom: 18 }}>
          {q ? tr("tasks.emptyNoResultsDesc", { query: q })
            : tr("tasks.emptyAllDesc")}
        </div>
        {!q && <button className="btn btn-primary" onClick={onCreate}><Plus size={14} /> {tr("tasks.createTask")}</button>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   CREATE/EDIT TASK MODAL
   ═══════════════════════════════════════════════════════════ */
/* ─── Task collaboration (subtasks · comments · files · collaborators) ─────── */
interface CollabUser { id: string; name: string | null; image: string | null; }
interface SubTask { id: string; title: string; status: string; assignee: CollabUser | null; dueDate: string | null; }
interface TaskCommentT { id: string; body: string; createdAt: string; userId: string | null; authorName: string | null; user: CollabUser | null; }
interface AttachmentT { id: string; fileName: string; fileSize: number | null; mimeType: string | null; createdAt: string; uploadedById: string | null; uploadedBy: { id: string; name: string | null } | null; }
interface CollaboratorT { id: string; userId: string; user: CollabUser; }
interface TaskDetail {
  id: string; assignee: CollabUser | null; assigneeId: string | null;
  subtasks: SubTask[]; comments: TaskCommentT[]; attachments: AttachmentT[]; collaborators: CollaboratorT[]; assignees: CollaboratorT[];
}

function fmtSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const collabLabelStyle: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em",
  display: "flex", alignItems: "center", gap: 6, marginBottom: 8,
};

function TaskCollab({ taskId, users, currentUserId, isAdmin, onChanged, onOpenTask }: {
  taskId: string; users: UserItem[]; currentUserId?: string; isAdmin: boolean; onChanged: () => void; onOpenTask?: (id: string) => void;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [subTab, setSubTab] = useState<"subtasks" | "comments" | "files">("subtasks");
  const [newSub, setNewSub] = useState("");
  const [newComment, setNewComment] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addAsgOpen, setAddAsgOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const r = await fetch(`/api/tasks/${taskId}`);
    if (r.ok) setDetail(await r.json());
  }, [taskId]);
  useEffect(() => { reload(); }, [reload]);

  const after = async () => { await reload(); onChanged(); };

  const addSubtask = async () => {
    const title = newSub.trim();
    if (!title) return;
    setNewSub("");
    await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, parentId: taskId }) });
    await after();
  };
  const toggleSub = async (s: SubTask) => {
    await fetch("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: s.id, status: s.status === "done" ? "open" : "done" }) });
    await after();
  };
  const delSub = async (s: SubTask) => {
    await fetch("/api/tasks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: s.id }) });
    await after();
  };
  const addComment = async () => {
    const body = newComment.trim();
    if (!body) return;
    setNewComment("");
    await fetch(`/api/tasks/${taskId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
    await after();
  };
  const delComment = async (id: string) => {
    await fetch(`/api/tasks/${taskId}/comments?commentId=${id}`, { method: "DELETE" });
    await after();
  };
  const upload = async (file: File) => {
    setUploadErr("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
      if (!r.ok) { setUploadErr(r.status === 413 ? tr("tasks.fileTooLarge") : tr("tasks.uploadFailed")); return; }
      await after();
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const delAttachment = async (id: string) => {
    await fetch(`/api/tasks/${taskId}/attachments/${id}`, { method: "DELETE" });
    await after();
  };
  const addCollaborator = async (uid: string) => {
    setAddOpen(false);
    await fetch(`/api/tasks/${taskId}/collaborators`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: uid }) });
    await after();
  };
  const removeCollaborator = async (uid: string) => {
    await fetch(`/api/tasks/${taskId}/collaborators?userId=${uid}`, { method: "DELETE" });
    await after();
  };
  const addAssignee = async (uid: string) => {
    setAddAsgOpen(false);
    await fetch(`/api/tasks/${taskId}/assignees`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: uid }) });
    await after();
  };
  const removeAssignee = async (uid: string) => {
    await fetch(`/api/tasks/${taskId}/assignees?userId=${uid}`, { method: "DELETE" });
    await after();
  };

  if (!detail) return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, textAlign: "center" }}>
      <Loader2 size={16} className="spin" style={{ color: "var(--muted)" }} />
    </div>
  );

  // A person is either an assignee or a collaborator — keep the two pickers disjoint.
  const taken = new Set<string>([...detail.assignees.map(a => a.userId), ...detail.collaborators.map(c => c.userId)]);
  const candidates = users.filter(u => !taken.has(u.id));
  const fmtTime = (s: string) => new Date(s).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const canDel = (ownerId: string | null) => isAdmin || (ownerId != null && ownerId === currentUserId);

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Assignees (виконавці) — multiple, the people responsible for the task */}
      <div>
        <div style={collabLabelStyle}><Users size={13} /> {tr("tasks.assignees")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {detail.assignees.map(a => (
            <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "3px 8px 3px 3px" }}>
              <Avatar name={a.user.name || "?"} image={a.user.image} size="sm" />
              <span style={{ fontSize: 12 }}>{(a.user.name || "").split(" ")[0] || "?"}</span>
              <button onClick={() => removeAssignee(a.userId)} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}><X size={12} /></button>
            </span>
          ))}
          <div style={{ position: "relative" }}>
            <button onClick={() => setAddAsgOpen(o => !o)} className="btn btn-sm" style={{ borderRadius: 999, padding: "4px 10px", borderStyle: "dashed" }} disabled={candidates.length === 0}>
              <Plus size={13} /> {tr("tasks.addAssignee")}
            </button>
            {addAsgOpen && candidates.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, background: "var(--card, #181a20)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, minWidth: 200, maxHeight: 240, overflowY: "auto", boxShadow: "0 12px 30px -8px rgba(0,0,0,.5)" }}>
                {candidates.map(u => (
                  <button key={u.id} onClick={() => addAssignee(u.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: "inherit", borderRadius: 6, textAlign: "left" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <Avatar name={u.name} image={u.image} size="sm" />
                    <span style={{ fontSize: 13 }}>{u.name || u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Collaborators */}
      <div>
        <div style={collabLabelStyle}><Users size={13} /> {tr("tasks.collaborators")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {detail.collaborators.map(c => (
            <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "3px 8px 3px 3px" }}>
              <Avatar name={c.user.name || "?"} image={c.user.image} size="sm" />
              <span style={{ fontSize: 12 }}>{(c.user.name || "").split(" ")[0] || "?"}</span>
              <button onClick={() => removeCollaborator(c.userId)} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}><X size={12} /></button>
            </span>
          ))}
          <div style={{ position: "relative" }}>
            <button onClick={() => setAddOpen(o => !o)} className="btn btn-sm" style={{ borderRadius: 999, padding: "4px 10px", borderStyle: "dashed" }} disabled={candidates.length === 0}>
              <Plus size={13} /> {tr("tasks.addCollaborator")}
            </button>
            {addOpen && candidates.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, background: "var(--card, #181a20)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, minWidth: 200, maxHeight: 240, overflowY: "auto", boxShadow: "0 12px 30px -8px rgba(0,0,0,.5)" }}>
                {candidates.map(u => (
                  <button key={u.id} onClick={() => addCollaborator(u.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: "inherit", borderRadius: 6, textAlign: "left" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <Avatar name={u.name} image={u.image} size="sm" />
                    <span style={{ fontSize: 13 }}>{u.name || u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sub-tab strip */}
      <div style={{ display: "flex", gap: 4, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 3 }}>
        {([
          { id: "subtasks" as const, icon: GitBranch, label: tr("tasks.subtasks"), n: detail.subtasks.length },
          { id: "comments" as const, icon: MessageSquare, label: tr("tasks.comments"), n: detail.comments.length },
          { id: "files" as const, icon: Paperclip, label: tr("tasks.attachments"), n: detail.attachments.length },
        ]).map(t => {
          const active = subTab === t.id;
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setSubTab(t.id)} className="btn btn-sm" style={{
              flex: 1, justifyContent: "center", gap: 6, border: "none", borderRadius: 7,
              background: active ? "var(--surface-2, #2a2a32)" : "transparent", fontWeight: active ? 600 : 500,
              color: active ? "var(--text)" : "var(--muted)",
            }}>
              <Icon size={13} /> {t.label}{t.n > 0 ? ` (${t.n})` : ""}
            </button>
          );
        })}
      </div>

      {/* Panels */}
      {subTab === "subtasks" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {detail.subtasks.map(s => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }}>
              <StatusCheckbox status={s.status} onClick={(e) => { e.stopPropagation(); toggleSub(s); }} />
              <span onClick={onOpenTask ? () => onOpenTask(s.id) : undefined}
                title={onOpenTask ? tr("tasks.openSubtask") : undefined}
                style={{ flex: 1, fontSize: 13, color: s.status === "done" ? "var(--muted)" : "var(--text)", textDecoration: s.status === "done" ? "line-through" : "none", cursor: onOpenTask ? "pointer" : "default" }}>{s.title}</span>
              {s.assignee && <Avatar name={s.assignee.name || "?"} image={s.assignee.image} size="sm" />}
              <button onClick={() => delSub(s)} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 2, display: "flex" }}><Trash2 size={13} /></button>
            </div>
          ))}
          {detail.subtasks.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "2px 2px 6px" }}>{tr("tasks.noSubtasks")}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addSubtask(); }}
              placeholder={tr("tasks.subtaskPlaceholder")}
              style={{ flex: 1, height: 36, padding: "0 12px", fontSize: 13, borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
            <button className="btn btn-sm" onClick={addSubtask} disabled={!newSub.trim()} style={{ opacity: newSub.trim() ? 1 : 0.5 }}><Plus size={14} /></button>
          </div>
        </div>
      )}

      {subTab === "comments" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {detail.comments.map(c => (
            <div key={c.id} style={{ display: "flex", gap: 10 }}>
              <Avatar name={c.user?.name || c.authorName || "?"} image={c.user?.image || null} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{c.user?.name || c.authorName || "?"}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{fmtTime(c.createdAt)}</span>
                  {canDel(c.userId) && (
                    <button onClick={() => delComment(c.id)} title={tr("common.delete")} style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}><X size={12} /></button>
                  )}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.body}</div>
              </div>
            </div>
          ))}
          {detail.comments.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{tr("tasks.noComments")}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea value={newComment} onChange={e => setNewComment(e.target.value)} rows={2}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(); }}
              placeholder={tr("tasks.commentPlaceholder")}
              style={{ flex: 1, resize: "vertical", fontSize: 13, lineHeight: 1.5, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", outline: "none", color: "var(--text)" }} />
            <button className="btn btn-primary btn-sm" onClick={addComment} disabled={!newComment.trim()} style={{ opacity: newComment.trim() ? 1 : 0.5, height: 38 }}>
              <Send size={14} /> {tr("tasks.sendComment")}
            </button>
          </div>
        </div>
      )}

      {subTab === "files" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {detail.attachments.map(a => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }}>
              <Paperclip size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtSize(a.fileSize)}{a.uploadedBy?.name ? ` · ${a.uploadedBy.name}` : ""}</div>
              </div>
              <a href={`/api/tasks/${taskId}/attachments/${a.id}`} title={tr("tasks.download")} download
                style={{ color: "var(--muted)", display: "flex", padding: 2 }}><Download size={15} /></a>
              {canDel(a.uploadedById) && (
                <button onClick={() => delAttachment(a.id)} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 2, display: "flex" }}><Trash2 size={13} /></button>
              )}
            </div>
          ))}
          {detail.attachments.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "2px 2px 6px" }}>{tr("tasks.noAttachments")}</div>}
          {uploadErr && <div style={{ fontSize: 12, color: "var(--red)" }}>{uploadErr}</div>}
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading} style={{ alignSelf: "flex-start" }}>
            {uploading ? <Loader2 size={14} className="spin" /> : <UploadCloud size={14} />} {uploading ? tr("tasks.uploading") : tr("tasks.uploadFile")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Custom task fields (P3.3) ─────────────────────────────
   Renders the system Tasks table's CUSTOM engine fields inside the task
   drawer: editable types via the shared FieldCell (writes hit PATCH
   /api/tasks {cells}), the rest read-only. Admins can add/edit/delete the
   field schema via the engine FieldEditor → /api/tasks/fields. */
function TaskCustomFields({ taskId, fields, initialCells, members, isAdmin, onChanged, onFieldsChanged }: {
  taskId: string; fields: FieldT[]; initialCells: Record<string, unknown>;
  members: OrgMember[]; isAdmin: boolean; onChanged: () => void; onFieldsChanged: () => void;
}) {
  const tr = useTranslations();
  const [cells, setCells] = useState<Record<string, unknown>>(initialCells);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<FieldT | null>(null);
  useEffect(() => { setCells(initialCells); /* reseed on task switch */ }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitCell = (fieldId: string, value: unknown) => {
    setCells(c => ({ ...c, [fieldId]: value })); // optimistic; the board refresh reconciles
    fetch("/api/tasks", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, cells: { [fieldId]: value } }),
    }).then(() => onChanged()).catch(() => {});
  };

  const saveField = async (draft: FieldDraft) => {
    const editing = editingField;
    await fetch(editing ? `/api/tasks/fields/${editing.id}` : "/api/tasks/fields", {
      method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).catch(() => {});
    setEditingField(null);
    onFieldsChanged();
  };

  const deleteField = async (f: FieldT) => {
    if (typeof window !== "undefined" && !window.confirm(tr("tasks.deleteFieldConfirm", { name: f.name }))) return;
    await fetch(`/api/tasks/fields/${f.id}`, { method: "DELETE" }).catch(() => {});
    onFieldsChanged();
  };

  if (!fields.length && !isAdmin) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>{tr("tasks.customFields")}</label>
        {isAdmin && (
          <button className="btn btn-sm" style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 12 }}
            onClick={() => { setEditingField(null); setEditorOpen(true); }}>
            <Plus size={12} /> {tr("database.addField")}
          </button>
        )}
      </div>
      {fields.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{tr("tasks.noCustomFields")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {fields.map(f => {
            const editable = EDITABLE_CUSTOM_TYPES.has(f.type);
            return (
              <div key={f.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>{f.name}</span>
                  {isAdmin && (
                    <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                      <button className="btn btn-sm" title={tr("database.editField")} style={{ padding: "2px 5px" }} onClick={() => { setEditingField(f); setEditorOpen(true); }}><MoreHorizontal size={12} /></button>
                      <button className="btn btn-sm" title={tr("common.delete")} style={{ padding: "2px 5px", color: "var(--red)" }} onClick={() => deleteField(f)}><Trash2 size={12} /></button>
                    </span>
                  )}
                </div>
                {editable ? (
                  <div style={{ minHeight: 38, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", display: "flex", alignItems: "center", overflow: "hidden" }}>
                    <FieldCell field={f} value={cells[f.id]} members={members} onCommit={(v) => commitCell(f.id, v)} />
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "8px 0" }}>{tr("tasks.fieldReadOnly")}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <FieldEditor open={editorOpen} initial={editingField} onClose={() => setEditorOpen(false)} onSave={saveField} />
    </div>
  );
}

function TaskModal({ open, task, meetings, users, currentUserId, isAdmin, customFields, members, onFieldsChanged, onClose, onSaved, onChanged, onOpenById }: {
  open: boolean; task: Task | null; meetings: MeetingOption[]; users: UserItem[];
  currentUserId?: string; isAdmin: boolean;
  customFields: FieldT[]; members: OrgMember[]; onFieldsChanged: () => void;
  onClose: () => void; onSaved: () => void; onChanged: () => void; onOpenById?: (id: string) => void;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const isNew = !task;
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState("open");
  const [newCells, setNewCells] = useState<Record<string, unknown>>({}); // custom-field values for a NEW task (no row yet)
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingQ, setMeetingQ] = useState("");
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState("");
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch("/api/departments").then((r) => (r.ok ? r.json() : [])).then((d) => setDepartments(Array.isArray(d) ? d.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })) : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title); setDesc(task.description || "");
      setMeetingId(task.meetingId);
      // Prefer the full multi-assignee set; fall back to the single lead.
      const ids = task.assignees?.length
        ? task.assignees.map(a => a.user.id)
        : (task.assigneeId || task.assignee?.id ? [task.assigneeId || task.assignee!.id] : []);
      setAssigneeIds(ids.filter((v): v is string => !!v));
      setPriority(task.priority); setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : "");
      setStatus(task.status); setDepartmentId(task.departmentId || "");
    } else {
      setTitle(""); setDesc(""); setMeetingId("");
      setAssigneeIds([]); setPriority("medium"); setDueDate(""); setStatus("open"); setDepartmentId(""); setNewCells({});
    }
    setMeetingOpen(false); setAssigneeOpen(false); setMeetingQ(""); setSaveErr(null);
  }, [open, task?.id]);

  if (!open) return null;

  const valid = title.trim().length >= 3;
  const meeting = meetings.find(m => m.id === meetingId);
  const assigneeCandidates = users.filter(u => !assigneeIds.includes(u.id));
  const meetingMatches = meetings.filter(m => !meetingQ || m.title.toLowerCase().includes(meetingQ.toLowerCase()));

  const generateDesc = async () => {
    if (aiLoading || title.trim().length < 3) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/tasks/ai-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), currentDescription: desc.trim() || null }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.description) setDesc(data.description);
      }
    } catch (e) { console.error("AI generate failed:", e); }
    finally { setAiLoading(false); }
  };

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true); setSaveErr(null);
    try {
      const res = isNew
        ? await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, description: desc || null, meetingId: meetingId || null, assigneeId: assigneeIds[0] || null, assigneeIds, priority, dueDate: dueDate || null, departmentId: departmentId || null, cells: newCells }),
          })
        : await fetch("/api/tasks", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: task!.id, title, description: desc || null, meetingId: meetingId || null, assigneeIds, priority, dueDate: dueDate || null, status, departmentId: departmentId || null }),
          });
      // Was: fire-and-forget → onSaved() closed the drawer and refetched even on a
      // rejected save, so the edit silently reverted. Keep the drawer open on failure.
      if (!res.ok) { setSaveErr(tr('common.saveFailed')); return; }
      onSaved();
    } catch { setSaveErr(tr('common.saveFailed')); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!task) return;
    setSaving(true); setSaveErr(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
      if (!res.ok) { setSaveErr(tr('common.saveFailed')); return; }
      onSaved();
    } catch { setSaveErr(tr('common.saveFailed')); }
    finally { setSaving(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(8,10,14,.5)", backdropFilter: "blur(4px)",
      zIndex: 950, display: "flex", alignItems: "stretch", justifyContent: "flex-end",
      animation: "bgIn .18s ease",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--card, #181a20)", borderLeft: "1px solid var(--border)", borderRadius: "16px 0 0 16px",
        width: "min(600px, 100vw)", maxWidth: "100vw", height: "100%", display: "flex", flexDirection: "column",
        boxShadow: "-28px 0 70px -12px rgba(0,0,0,.65)", animation: "drawerIn .24s cubic-bezier(.32,.72,0,1)",
      }}>
        {/* Header */}
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "color-mix(in oklab, var(--accent) 18%, transparent)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ListChecks size={15} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{isNew ? tr("tasks.newTask") : tr("tasks.editTask")}</div>
          {!isNew && task?.source === "ai" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 8px", borderRadius: 6,
              background: "color-mix(in oklab, var(--accent) 14%, transparent)", color: "#bfdbfe" }}>
              <Sparkles size={10} /> AI
            </span>
          )}
          <button className="btn btn-sm" style={{ marginLeft: "auto", padding: "4px 6px" }} onClick={onClose}><X size={15} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 22px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
            placeholder={tr("tasks.titlePlaceholder")}
            style={{ fontSize: 17, fontWeight: 600, background: "transparent", border: "none", padding: "4px 0",
              borderBottom: "1px solid var(--border)", borderRadius: 0, outline: "none", color: "var(--text)", width: "100%" }} />

          <div style={{ position: "relative" }}>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={3}
              placeholder={tr("tasks.descriptionPlaceholder")}
              style={{ resize: "vertical", fontSize: 13, lineHeight: 1.55, background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 10, padding: "10px 12px", paddingRight: 42, outline: "none", color: "var(--text)", width: "100%" }} />
            <button
              onClick={generateDesc}
              disabled={aiLoading || title.trim().length < 3}
              title={desc.trim() ? tr("tasks.aiRegenerateDescription") : tr("tasks.aiGenerateDescription")}
              style={{
                position: "absolute", top: 8, right: 8,
                width: 30, height: 30, borderRadius: 8, border: "none", cursor: aiLoading || title.trim().length < 3 ? "not-allowed" : "pointer",
                background: aiLoading ? "color-mix(in oklab, var(--accent) 25%, transparent)" : "color-mix(in oklab, var(--accent) 12%, transparent)",
                color: title.trim().length < 3 ? "var(--muted)" : "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all .2s", opacity: title.trim().length < 3 ? 0.4 : 1,
                padding: 0,
              }}
              onMouseEnter={e => { if (!aiLoading && title.trim().length >= 3) e.currentTarget.style.background = "color-mix(in oklab, var(--accent) 30%, transparent)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = aiLoading ? "color-mix(in oklab, var(--accent) 25%, transparent)" : "color-mix(in oklab, var(--accent) 12%, transparent)"; }}
            >
              {aiLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Wand2 size={14} />}
            </button>
          </div>

          {/* Meeting picker */}
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("tasks.meeting")}</label>
            <button onClick={() => setMeetingOpen(o => !o)} className="btn" style={{
              width: "100%", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10,
              background: "var(--surface)", border: "1px solid var(--border)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {meetingId ? <Video size={13} style={{ color: "var(--muted)" }} /> : <ListChecks size={13} style={{ color: "var(--muted)" }} />}
                <span style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {meeting?.title || (meetingId ? tr("tasks.selectMeeting") : tr("tasks.noMeeting"))}
                </span>
              </span>
              <ChevronDown size={14} style={{ color: "var(--muted)", transform: meetingOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
            </button>
            {meetingOpen && (
              <div style={{ marginTop: 6, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--card, #181a20)" }}>
                <div style={{ position: "relative" }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                  <input autoFocus placeholder={tr("tasks.searchMeeting")} value={meetingQ} onChange={e => setMeetingQ(e.target.value)}
                    style={{ paddingLeft: 32, border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, height: 34,
                      background: "transparent", outline: "none", color: "var(--text)", width: "100%", fontSize: 13 }} />
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  <button onClick={() => { setMeetingId(""); setMeetingOpen(false); setMeetingQ(""); }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px",
                      background: !meetingId ? "var(--surface)" : "transparent", border: "none", cursor: "pointer", color: "inherit", textAlign: "left",
                      borderBottom: "1px solid var(--border)" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface)")}
                    onMouseLeave={e => (e.currentTarget.style.background = !meetingId ? "var(--surface)" : "transparent")}
                  >
                    <span style={{ fontSize: 13, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
                      <ListChecks size={12} /> {tr("tasks.noMeeting")}
                    </span>
                    {!meetingId && <Check size={13} style={{ color: "var(--accent)" }} />}
                  </button>
                  {meetingMatches.map(m => (
                    <button key={m.id} onClick={() => { setMeetingId(m.id); setMeetingOpen(false); setMeetingQ(""); }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px",
                        background: m.id === meetingId ? "var(--surface)" : "transparent", border: "none", cursor: "pointer", color: "inherit", textAlign: "left" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface)")}
                      onMouseLeave={e => (e.currentTarget.style.background = m.id === meetingId ? "var(--surface)" : "transparent")}
                    >
                      <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{m.title}</span>
                      {m.scheduledAt && <span style={{ fontSize: 10.5, color: "var(--muted)", marginLeft: 8, fontFamily: "var(--font-mono, monospace)" }}>
                        {new Date(m.scheduledAt).toLocaleDateString(locale, { day: "numeric", month: "short" })}
                      </span>}
                    </button>
                  ))}
                  {meetingMatches.length === 0 && <div style={{ padding: "12px", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>{tr("tasks.nothingFound")}</div>}
                </div>
              </div>
            )}
          </div>

          {departments.length > 0 && (
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("departments.label")}</label>
              <Select
                value={departmentId}
                onChange={setDepartmentId}
                placeholder={tr("departments.none")}
                options={[{ value: "", label: tr("departments.none") }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
                style={{ width: "100%" }}
              />
            </div>
          )}

          {/* Assignees (multiple — the first is the lead) */}
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("tasks.assignees")}</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {assigneeIds.map(id => {
                const u = users.find(x => x.id === id);
                const label = u ? (u.name || u.email) : id;
                return (
                  <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "3px 8px 3px 3px" }}>
                    {u ? <Avatar name={u.name} image={u.image} size="sm" /> : <User size={13} style={{ color: "var(--muted)", margin: "0 2px" }} />}
                    <span style={{ fontSize: 12 }}>{(label || "").split(" ")[0] || label}</span>
                    <button onClick={() => setAssigneeIds(ids => ids.filter(x => x !== id))} title={tr("common.delete")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}><X size={12} /></button>
                  </span>
                );
              })}
              <div style={{ position: "relative" }}>
                <button onClick={() => setAssigneeOpen(o => !o)} className="btn btn-sm" style={{ borderRadius: 999, padding: "4px 10px", borderStyle: "dashed" }} disabled={assigneeCandidates.length === 0}>
                  <Plus size={13} /> {assigneeIds.length === 0 ? tr("tasks.assignee") : tr("tasks.addAssignee")}
                </button>
                {assigneeOpen && assigneeCandidates.length > 0 && (
                  <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, background: "var(--card, #181a20)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, minWidth: 220, maxHeight: 240, overflowY: "auto", boxShadow: "0 12px 30px -8px rgba(0,0,0,.5)" }}>
                    {assigneeCandidates.map(u => (
                      <button key={u.id} onClick={() => { setAssigneeIds(ids => [...ids, u.id]); setAssigneeOpen(false); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: "inherit", borderRadius: 6, textAlign: "left" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <Avatar name={u.name} image={u.image} size="sm" />
                        <span style={{ fontSize: 13 }}>{u.name || u.email}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Due date */}
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("tasks.dueDate")}</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              style={{ height: 38, padding: "0 12px", fontSize: 13, borderRadius: 10, background: "var(--surface)",
                border: "1px solid var(--border)", color: "var(--text)", outline: "none", width: "100%" }} />
          </div>

          {/* Priority */}
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("tasks.priority")}</label>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { id: "high", label: tr("tasks.priorityHigh"), c: "var(--red)" },
                { id: "medium", label: tr("tasks.priorityMedium"), c: "var(--amber)" },
                { id: "low", label: tr("tasks.priorityLow"), c: "var(--muted)" },
              ].map(p => {
                const active = priority === p.id;
                return (
                  <button key={p.id} onClick={() => setPriority(p.id)} className="btn btn-sm" style={{
                    flex: 1, justifyContent: "center",
                    background: active ? `color-mix(in oklab, ${p.c} 18%, transparent)` : "var(--surface)",
                    border: "1px solid " + (active ? `color-mix(in oklab, ${p.c} 50%, transparent)` : "var(--border)"),
                    color: active ? p.c : "var(--text-2)", fontWeight: active ? 600 : 500,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.c }} /> {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom fields (new task) — edited in local state, sent with create */}
          {isNew && customFields.some(f => EDITABLE_CUSTOM_TYPES.has(f.type)) && (
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 8 }}>{tr("tasks.customFields")}</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {customFields.filter(f => EDITABLE_CUSTOM_TYPES.has(f.type)).map(f => (
                  <div key={f.id}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>{f.name}</span>
                    <div style={{ minHeight: 38, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", display: "flex", alignItems: "center", overflow: "hidden" }}>
                      <FieldCell field={f} value={newCells[f.id]} members={members} onCommit={(v) => setNewCells(c => ({ ...c, [f.id]: v }))} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status (edit only) */}
          {!isNew && (
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>{tr("tasks.status")}</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { id: "open", label: tr("tasks.statusOpenSingular"), c: "var(--accent)" },
                  { id: "in_progress", label: tr("tasks.statusInProgress"), c: "var(--amber)" },
                  { id: "done", label: tr("tasks.statusDone"), c: "var(--green)" },
                ].map(s => {
                  const active = status === s.id;
                  return (
                    <button key={s.id} onClick={() => setStatus(s.id)} className="btn btn-sm" style={{
                      flex: 1, justifyContent: "center",
                      background: active ? `color-mix(in oklab, ${s.c} 18%, transparent)` : "var(--surface)",
                      border: "1px solid " + (active ? `color-mix(in oklab, ${s.c} 50%, transparent)` : "var(--border)"),
                      color: active ? s.c : "var(--text-2)", fontWeight: active ? 600 : 500,
                    }}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!isNew && task && (customFields.length > 0 || isAdmin) && (
            <TaskCustomFields taskId={task.id} fields={customFields} initialCells={task.cells ?? {}}
              members={members} isAdmin={isAdmin} onChanged={onChanged} onFieldsChanged={onFieldsChanged} />
          )}

          {!isNew && task && (
            <TaskCollab taskId={task.id} users={users} currentUserId={currentUserId} isAdmin={isAdmin} onChanged={onChanged} onOpenTask={onOpenById} />
          )}
        </div>

        {(task?.clickupManaged || task?.linearManaged) && (
          <div style={{ margin: "0 22px 12px", padding: "10px 12px", borderRadius: 8, background: "color-mix(in oklab, var(--accent) 10%, transparent)", border: "1px solid color-mix(in oklab, var(--accent) 30%, transparent)", fontSize: 12.5, color: "var(--accent)", display: "flex", alignItems: "center", gap: 8 }}>
            <span>{task?.linearManaged ? tr("tasks.linearManagedNotice") : tr("tasks.clickupManagedNotice")}</span>
            {(task?.linearManaged ? task.linearUrl : task.clickupUrl) && <a href={(task?.linearManaged ? task.linearUrl : task.clickupUrl) || "#"} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>{task?.linearManaged ? "Linear ↗" : "ClickUp ↗"}</a>}
          </div>
        )}

        {saveErr && (
          <div role="alert" style={{ padding: "10px 22px", color: "var(--red)", fontSize: 13, background: "color-mix(in oklab, var(--red) 10%, transparent)", borderTop: "1px solid color-mix(in oklab, var(--red) 25%, transparent)" }}>
            {saveErr}
          </div>
        )}
        {/* Footer */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          {/* Deletable unless Linear owns it — Linear has no delete path, so removing
              the Garely row there would orphan the issue. A ClickUp-mirrored task IS
              deletable now, but it also destroys the ClickUp copies (one per assignee),
              so it asks first; a plain local task keeps the old one-click behaviour. */}
          {!isNew && !task?.linearManaged && (
            <button
              className="btn btn-sm"
              disabled={saving}
              onClick={() => {
                if (task?.clickupManaged && !window.confirm(tr("tasks.confirmDeleteMirrored"))) return;
                void handleDelete();
              }}
              style={{ color: "var(--red)", borderColor: "color-mix(in oklab, var(--red) 30%, transparent)" }}>
              <Trash2 size={13} /> {tr("common.delete")}
            </button>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>{(task?.clickupManaged || task?.linearManaged) ? tr("common.close") : tr("common.cancel")}</button>
            {!(task?.clickupManaged || task?.linearManaged) && (
              <button className="btn btn-primary" disabled={!valid || saving} onClick={save}
                style={{ opacity: valid && !saving ? 1 : 0.5, fontWeight: 600 }}>
                {saving ? <Loader2 size={14} className="spin" /> : null}
                {isNew ? tr("tasks.createTask") : tr("common.save")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
function TabBtn({ active, onClick, label, badge }: { active: boolean; onClick: () => void; label: string; badge?: number }) {
  return (
    <button onClick={onClick} style={{
      position: "relative", padding: "8px 2px", marginRight: 12, background: "none", border: "none", cursor: "pointer",
      fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.1,
      color: active ? "var(--text)" : "var(--muted)",
      borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
      transition: "color .15s",
    }}>
      {label}
      {badge && badge > 0 ? (
        <span style={{ marginLeft: 7, fontSize: 11, fontWeight: 700, padding: "2px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", verticalAlign: "middle" }}>{badge > 9 ? "9+" : badge}</span>
      ) : null}
    </button>
  );
}

export default function TasksPage() {
  const tr = useTranslations();
  const { data: session } = useSession();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [fields, setFields] = useState<FieldT[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [meetings, setMeetings] = useState<MeetingOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<"list" | "kanban" | "dept">("list");
  const [scope, setScope] = useState("mine");
  const [filterMeeting, setFilterMeeting] = useState("all");
  const [filterPriority, setFilterPriority] = useState("all");
  const [filterAssignee, setFilterAssignee] = useState("all");
  const [filterDept, setFilterDept] = useState("all");
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({}); // custom singleSelect fieldId → choiceId | "all"
  const [departments, setDepartments] = useState<{ id: string; name: string; color: string | null; members: { userId: string }[] }[]>([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Task | null | "new">(null);
  const [tab, setTab] = useState<"tasks" | "quizzes">("tasks");

  const isAdmin = session?.user?.role === "admin";
  const userId = session?.user?.id;
  const isMobile = useIsMobile();
  const pendingQuiz = useQuizPending();

  const fetchTasks = useCallback(async () => {
    setError(false);
    try {
      // P3.3: ?withFields=1 returns { tasks, fields } so the board can render
      // CUSTOM task fields. Still tolerate a bare array (defensive).
      const res = await fetch("/api/tasks?scope=all&withFields=1");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setTasks(data);
        else { setTasks(Array.isArray(data.tasks) ? data.tasks : []); setFields(Array.isArray(data.fields) ? data.fields : []); }
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Custom-field schema refresh (after an admin add/edit/delete in the drawer).
  const refreshFields = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks/fields");
      if (r.ok) { const d = await r.json(); setFields(Array.isArray(d) ? d : []); }
    } catch { /* keep the current schema on a transient failure */ }
  }, []);

  // FieldCell wants the org members (person picker, avatars) in OrgMember shape.
  const members = useMemo<OrgMember[]>(
    () => users.map(u => ({ id: u.id, name: u.name, image: u.image, email: u.email })),
    [users],
  );
  const customFields = useMemo(() => customTaskFields(fields), [fields]);
  // Custom select-style fields are offered as board filter chips (client-side, by cell value).
  const filterableFields = useMemo(() => filterableCustomFields(customFields), [customFields]);

  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "quizzes") setTab("quizzes");
    // fetchTasks owns `loading` (it sets it false in its finally) — don't clear
    // it synchronously here, or the spinner never reflects the real fetch.
    fetchTasks();
    fetch("/api/users").then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
    fetch("/api/meetings").then(r => r.json()).then((data: any[]) => {
      setMeetings(data.map(m => ({ id: m.id, title: m.title, scheduledAt: m.scheduledAt })));
    }).catch(() => {});
    fetch("/api/departments").then(r => (r.ok ? r.json() : [])).then((d: any[]) => {
      if (Array.isArray(d)) setDepartments(d.map(x => ({ id: x.id, name: x.name, color: x.color ?? null, members: Array.isArray(x.members) ? x.members.map((m: any) => ({ userId: m.userId })) : [] })));
    }).catch(() => {});
  }, []);

  // Open a task's modal by id (fetches full detail) — shared by the deep-link
  // and by clicking a subtask inline in the list.
  const openById = useCallback((id: string) => {
    fetch(`/api/tasks/${id}`).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d && d.id) setEditing(d as Task);
    }).catch(() => {});
  }, []);

  // Deep-link: /tasks?task=ID opens that task's modal (notification links use it).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tid = new URLSearchParams(window.location.search).get("task");
    if (!tid) return;
    openById(tid);
    window.history.replaceState(null, "", "/tasks");
  }, [openById]);

  // Inline subtask edits patch the parent's nested subtasks in board state
  // (no full refetch — preserves expansion/scroll). Keeps _count in sync.
  const patchTaskSubtasks = useCallback((parentId: string, next: Subtask[]) => {
    setTasks(prev => prev.map(t => t.id === parentId
      ? { ...t, subtasks: next, _count: { subtasks: next.length, comments: t._count?.comments ?? 0, attachments: t._count?.attachments ?? 0 } }
      : t));
  }, []);

  // Effective department of a task = its explicit department, else the
  // assignee's department — so moving a user into a department attributes their
  // tasks to it automatically. A user in several departments → their first.
  const userDept = useMemo(() => {
    const m: Record<string, { id: string; name: string; color: string | null }> = {};
    for (const d of departments) for (const mem of d.members) if (!m[mem.userId]) m[mem.userId] = { id: d.id, name: d.name, color: d.color };
    return m;
  }, [departments]);

  const filtered = useMemo(() => tasks
    .map(t => {
      const aid = t.assigneeId || t.assignee?.id || "";
      const eff = t.department ?? (aid ? userDept[aid] : undefined) ?? null;
      return { ...t, department: eff, departmentId: eff?.id ?? null };
    })
    .filter(t => {
      if (scope === "mine" && t.assignee?.id !== userId && t.assigneeId !== userId) return false;
      if (filterMeeting !== "all" && t.meetingId !== filterMeeting) return false;
      if (filterPriority !== "all" && t.priority !== filterPriority) return false;
      if (filterAssignee !== "all" && t.assignee?.id !== filterAssignee && t.assigneeId !== filterAssignee) return false;
      if (filterDept !== "all" && t.departmentId !== filterDept) return false;
      if (!matchesCustomFilters(filterableFields, customFilters, t.cells as Record<string, unknown> | undefined)) return false;
      if (q) {
        const low = q.toLowerCase();
        if (!t.title.toLowerCase().includes(low) && !(t.description || "").toLowerCase().includes(low)) return false;
      }
      return true;
    }), [tasks, scope, filterMeeting, filterPriority, filterAssignee, filterDept, customFilters, filterableFields, q, userId, userDept]);

  const meetingOptions = useMemo(() => {
    const ids = [...new Set(tasks.map(t => t.meetingId))];
    return ids.map(id => meetings.find(m => m.id === id)).filter(Boolean) as MeetingOption[];
  }, [tasks, meetings]);

  const counts = useMemo(() => ({
    mine: tasks.filter(t => t.assignee?.id === userId || t.assigneeId === userId).length,
    all: tasks.length,
  }), [tasks, userId]);

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    { const ext = tasks.find(t => t.id === taskId); if (ext?.clickupManaged || ext?.linearManaged) return; } // read-only mirror — manage status in ClickUp/Linear
    const prevTasks = tasks;
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, status: newStatus }),
      });
      if (!res.ok) setTasks(prevTasks); // server rejected → revert the optimistic change
    } catch (e) {
      console.error(e);
      setTasks(prevTasks);
    }
  };

  // Inline quick-add from a list group. Create defaults to status "open"; for a
  // non-open status group or a department group, follow up with a PATCH/the
  // departmentId so the new task lands in the group the user typed into.
  const handleQuickCreate = useCallback(async (opts: { title: string; status?: string; departmentId?: string | null }) => {
    const body: Record<string, unknown> = { title: opts.title };
    if (opts.departmentId) body.departmentId = opts.departmentId;
    try {
      const res = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok && opts.status && opts.status !== "open") {
        const created = await res.json().catch(() => null);
        if (created?.id) await fetch("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: created.id, status: opts.status }) });
      }
    } finally {
      fetchTasks();
    }
  }, [fetchTasks]);

  const handleSaved = () => {
    setEditing(null);
    fetchTasks();
  };

  const switchTab = (t: "tasks" | "quizzes") => {
    setTab(t);
    if (typeof window !== "undefined") window.history.replaceState(null, "", t === "quizzes" ? "/tasks?tab=quizzes" : "/tasks");
  };

  if (loading) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Loader2 size={24} className="spin" style={{ color: "var(--muted)" }} />
    </div>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Page tabs: Tasks | Quizzes */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "12px clamp(14px, 4vw, 28px) 0", flexShrink: 0 }}>
        <TabBtn active={tab === "tasks"} onClick={() => switchTab("tasks")} label={tr("tasks.pageTitle")} />
        <TabBtn active={tab === "quizzes"} onClick={() => switchTab("quizzes")} label={tr("quiz.navTitle")} badge={pendingQuiz} />
      </div>

      {tab === "quizzes" ? (
        <QuizzesPanel />
      ) : (
      <>
      {/* Header */}
      <div style={{ padding: "12px clamp(14px, 4vw, 28px) 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 3 }}>
              <button onClick={() => setView("list")} className="btn btn-sm" style={{
                background: view === "list" ? "var(--surface-2, #2a2a32)" : "transparent",
                border: "none", borderRadius: 7, fontWeight: view === "list" ? 600 : 500,
              }}><LayoutList size={14} /> {tr("tasks.viewList")}</button>
              <button onClick={() => setView("kanban")} className="btn btn-sm" style={{
                background: view === "kanban" ? "var(--surface-2, #2a2a32)" : "transparent",
                border: "none", borderRadius: 7, fontWeight: view === "kanban" ? 600 : 500,
              }}><LayoutGrid size={14} /> {tr("tasks.viewKanban")}</button>
              {departments.length > 0 && (
                <button onClick={() => setView("dept")} className="btn btn-sm" style={{
                  background: view === "dept" ? "var(--surface-2, #2a2a32)" : "transparent",
                  border: "none", borderRadius: 7, fontWeight: view === "dept" ? 600 : 500,
                }}><Building2 size={14} /> {tr("departments.byDept")}</button>
              )}
            </div>
            <button className="btn btn-primary" onClick={() => setEditing("new")} style={{ fontWeight: 600 }}>
              <Plus size={15} /> {tr("tasks.newTask")}
            </button>
          </div>
        </div>
        {/* Filter row */}
        <div className="tasks-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <FilterPills value={scope} onChange={setScope} options={[
            { id: "mine", label: tr("tasks.scopeMine"), count: counts.mine },
            { id: "all", label: tr("tasks.scopeAll"), count: counts.all },
          ]} />
          <div className="tasks-filter-sep" style={{ width: 1, height: 24, background: "var(--border)" }} />
          <SelectChip icon={CalendarIcon} value={filterMeeting} onChange={setFilterMeeting}
            options={[{ value: "all", label: tr("tasks.filterAllMeetings") }, ...meetingOptions.map(m => ({ value: m.id, label: m.title }))]} />
          <SelectChip icon={AlertCircle} value={filterPriority} onChange={setFilterPriority}
            options={[
              { value: "all", label: tr("tasks.filterAnyPriority") },
              { value: "high", label: tr("tasks.priorityHigh") },
              { value: "medium", label: tr("tasks.priorityMedium") },
              { value: "low", label: tr("tasks.priorityLow") },
            ]} />
          {departments.length > 0 && (
            <SelectChip icon={Building2} value={filterDept} onChange={setFilterDept}
              options={[{ value: "all", label: tr("departments.filterAll") }, ...departments.map(d => ({ value: d.id, label: d.name }))]} />
          )}
          {isAdmin && (
            <SelectChip icon={User} value={filterAssignee} onChange={(v) => { setFilterAssignee(v); if (v !== "all") setScope("all"); }}
              options={[{ value: "all", label: tr("tasks.filterAllAssignees") }, ...users.map(u => ({ value: u.id, label: u.name || u.email }))]} />
          )}
          {filterableFields.map(f => (
            <SelectChip key={f.id} icon={SlidersHorizontal} value={customFilters[f.id] ?? "all"}
              onChange={(v) => setCustomFilters(p => ({ ...p, [f.id]: v }))}
              options={[{ value: "all", label: f.name }, ...(f.options?.choices ?? []).map(c => ({ value: c.id, label: c.name }))]} />
          ))}
          <div className="tasks-search" style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
            <input placeholder={tr("tasks.searchPlaceholder")} value={q} onChange={e => setQ(e.target.value)}
              style={{ paddingLeft: 34, height: 34, fontSize: 13, width: "100%", background: "var(--surface)",
                border: "1px solid var(--border)", borderRadius: 8, outline: "none", color: "var(--text)" }} />
            {q && <button onClick={() => setQ("")} className="btn btn-sm" style={{ position: "absolute", right: 4, top: 4, width: 26, height: 26, padding: 0 }}><X size={12} /></button>}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {error ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
            <AlertCircle size={28} style={{ color: "var(--danger, #e5484d)" }} />
            <div style={{ color: "var(--muted)", fontSize: 14 }}>{tr("tasks.loadError")}</div>
            <button className="btn btn-sm" onClick={() => { setLoading(true); fetchTasks(); }}>{tr("tasks.retry")}</button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState scope={scope} q={q} onCreate={() => setEditing("new")} />
        ) : view === "list" ? (
          <TaskListView tasks={filtered} onEdit={t => setEditing(t)} onStatusChange={handleStatusChange} q={q} mobile={isMobile} departments={departments} onOpenById={openById} onSubtaskChange={patchTaskSubtasks} onQuickCreate={handleQuickCreate} customFields={customFields} members={members} />
        ) : view === "dept" ? (
          <TaskListView tasks={filtered} onEdit={t => setEditing(t)} onStatusChange={handleStatusChange} q={q} mobile={isMobile} groupBy="department" departments={departments} onOpenById={openById} onSubtaskChange={patchTaskSubtasks} onQuickCreate={handleQuickCreate} customFields={customFields} members={members} />
        ) : (
          <KanbanView tasks={filtered} onEdit={t => setEditing(t)} onStatusChange={handleStatusChange} customFields={customFields} members={members} />
        )}
      </div>

      <TaskModal open={!!editing} task={editing === "new" ? null : editing as Task}
        meetings={meetings} users={users} currentUserId={userId} isAdmin={isAdmin}
        customFields={customFields} members={members} onFieldsChanged={refreshFields}
        onClose={() => setEditing(null)} onSaved={handleSaved} onChanged={fetchTasks} onOpenById={openById} />
      </>
      )}
    </div>
  );
}
