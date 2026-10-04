import React from 'react';
import { Loader2, Inbox, AlertTriangle, X } from 'lucide-react';

export const LoadingState: React.FC<{ message?: string }> = ({
  message = 'Loading pharmacy records...',
}) => (
  <div className="h-64 flex flex-col items-center justify-center text-slate-500">
    <Loader2 className="w-6 h-6 text-teal-600 animate-spin mb-2" />
    <span className="text-xs font-medium">{message}</span>
  </div>
);

export const EmptyState: React.FC<{
  title?: string;
  description?: string;
  action?: React.ReactNode;
}> = ({
  title = 'No records found',
  description = 'There are no items matching this criteria.',
  action,
}) => (
  <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-center p-6">
    <Inbox className="w-10 h-10 text-slate-300 mb-2" />
    <h4 className="text-xs font-bold text-slate-700">{title}</h4>
    <p className="text-[11px] text-slate-400 mt-0.5 max-w-sm">{description}</p>
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const ErrorState: React.FC<{
  title?: string;
  message?: string;
  onRetry?: () => void;
}> = ({
  title = 'Operation Error',
  message = 'An unexpected error occurred while communicating with the data store.',
  onRetry,
}) => (
  <div className="p-6 text-center bg-rose-50 border border-rose-200 rounded-lg max-w-md mx-auto my-8">
    <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
    <h4 className="text-xs font-bold text-rose-900">{title}</h4>
    <p className="text-[11px] text-rose-700 mt-1">{message}</p>
    {onRetry && (
      <button
        onClick={onRetry}
        className="mt-3 px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
      >
        Retry Action
      </button>
    )}
  </div>
);

export const Modal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
}> = ({ isOpen, onClose, title, subtitle, children, maxWidth = 'max-w-md' }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className={`w-full ${maxWidth} bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800`}>
        <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
          <div>
            <h3 className="font-bold text-xs tracking-tight">{title}</h3>
            {subtitle && <p className="text-[10px] text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
};
