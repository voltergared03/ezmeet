'use client';

/* ══════════════════════════════════════════════════════════
   CONTROL BUTTON
   ══════════════════════════════════════════════════════════ */
export function ControlBtn({ active, onClick, icon, label, danger, badge, className }: {
  active: boolean; onClick: () => void; icon: React.ReactNode;
  label: string; danger?: boolean; badge?: number; className?: string;
}) {
  return (
    <button onClick={onClick} title={label} className={"room-ctrl-btn" + (className ? " " + className : "")} style={{
      position: 'relative',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '8px 14px', borderRadius: 12, cursor: 'pointer',
      background: danger ? 'rgba(239,68,68,.15)' : active ? 'var(--hover)' : 'var(--hover)',
      color: danger ? '#fca5a5' : active ? '#fff' : 'rgba(255,255,255,.6)',
      border: danger ? '1px solid rgba(239,68,68,.3)' : '1px solid var(--hover)',
      transition: 'all .15s', minWidth: 0, flexShrink: 0,
    }}>
      {icon}
      <span className="room-ctrl-label" style={{ fontSize: 10, fontWeight: 500 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={{
          position: 'absolute', top: 2, right: 6,
          width: 16, height: 16, borderRadius: '50%',
          background: 'var(--accent)', color: 'var(--on-accent)',
          fontSize: 9, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{badge > 9 ? '9+' : badge}</span>
      )}
      <style>{`
        @media (max-width: 768px) {
          .room-ctrl-btn { width: 44px !important; height: 44px !important; padding: 0 !important; border-radius: 50% !important; justify-content: center !important; min-width: 44px !important; }
          .room-ctrl-label { display: none !important; }
        }
      `}</style>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   MORE-MENU ITEM (row inside the ⋮ overflow popover)
   ══════════════════════════════════════════════════════════ */
export function MoreItem({ icon, label, onClick, active, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; danger?: boolean;
}) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
      background: danger ? 'rgba(239,68,68,.14)' : active ? 'var(--hover)' : 'transparent',
      color: danger ? '#fca5a5' : active ? '#fff' : 'rgba(255,255,255,.78)',
      border: '1px solid ' + (danger ? 'rgba(239,68,68,.3)' : 'transparent'),
      fontSize: 13, fontWeight: 500, transition: 'background .12s',
    }}
      onMouseEnter={(e) => { if (!active && !danger) e.currentTarget.style.background = 'var(--hover)'; }}
      onMouseLeave={(e) => { if (!active && !danger) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
