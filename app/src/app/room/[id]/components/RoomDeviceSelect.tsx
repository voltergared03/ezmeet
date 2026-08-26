'use client';

import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';

/* ══════════════════════════════════════════════════════════
   ROOM DEVICE SELECT
   ══════════════════════════════════════════════════════════ */
export function RoomDeviceSelect({ label, icon, devices, value, onChange }: {
  label: string; icon: React.ReactNode; devices: MediaDeviceInfo[];
  value: string; onChange: (id: string) => void;
}) {
  const t = useTranslations();
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'rgba(255,255,255,.4)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
        {icon} {label}
      </div>
      <Select
        value={value}
        onChange={onChange}
        placeholder={t('room.notFound')}
        style={{ background: 'var(--hover)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--on-accent)', padding: '7px 9px', fontSize: 12.5 }}
        options={devices.map(d => ({ value: d.deviceId, label: d.label || t('room.deviceFallback', { id: d.deviceId.slice(0, 6) }) }))}
      />
    </div>
  );
}
