import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { hasPermission } from '../../services/permissions';
import type { PermissionKey, User } from '../../types';

interface PermissionGuardProps {
  user: User | null | undefined;
  permission: PermissionKey;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const PermissionGuard: React.FC<PermissionGuardProps> = ({
  user,
  permission,
  children,
  fallback,
}) => {
  const allowed = hasPermission(user, permission);

  if (allowed) {
    return <>{children}</>;
  }

  if (fallback !== undefined) {
    return <>{fallback}</>;
  }

  return (
    <div className="p-6 text-center bg-white rounded-lg border border-slate-200 shadow-xs max-w-sm mx-auto my-8">
      <ShieldAlert className="w-8 h-8 text-rose-500 mx-auto mb-2" />
      <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Access Restricted</h3>
      <p className="text-[11px] text-slate-500 mt-1">
        Your role ({user?.role || 'Guest'}) does not have the <code>{permission}</code> authorization required for this action.
      </p>
    </div>
  );
};
