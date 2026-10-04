import React from 'react';

interface StatusBadgeProps {
  status: string;
  variant?: 'emerald' | 'amber' | 'rose' | 'blue' | 'slate' | 'purple';
  label?: string;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  variant,
  label,
  className = '',
}) => {
  const getVariant = () => {
    if (variant) return variant;
    const s = status.toLowerCase();
    if (s.includes('active') || s.includes('synced') || s.includes('completed')) return 'emerald';
    if (s.includes('pending') || s.includes('low') || s.includes('held') || s.includes('syncing')) return 'amber';
    if (s.includes('expired') || s.includes('error') || s.includes('void') || s.includes('failed') || s.includes('disabled')) return 'rose';
    if (s.includes('manager') || s.includes('received')) return 'blue';
    if (s.includes('admin') || s.includes('quarantined')) return 'purple';
    return 'slate';
  };

  const v = getVariant();
  const colorMap = {
    emerald: { text: 'text-emerald-700', dot: 'bg-emerald-600' },
    amber: { text: 'text-amber-700', dot: 'bg-amber-600' },
    rose: { text: 'text-rose-700', dot: 'bg-rose-600' },
    blue: { text: 'text-slate-700', dot: 'bg-slate-500' },
    purple: { text: 'text-slate-800', dot: 'bg-teal-700' },
    slate: { text: 'text-slate-600', dot: 'bg-slate-400' },
  };

  const style = colorMap[v];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
      <span>{label || status}</span>
    </span>
  );
};

