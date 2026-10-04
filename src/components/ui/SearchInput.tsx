import React from 'react';
import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcutBadge?: string;
  autoFocus?: boolean;
  className?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value,
  onChange,
  placeholder = 'Search...',
  shortcutBadge,
  autoFocus = false,
  className = '',
}) => {
  return (
    <div className={`relative flex items-center ${className}`}>
      <Search className="w-4 h-4 absolute left-3 text-slate-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full pl-9 pr-12 py-1.5 border border-slate-300 rounded text-xs text-slate-800 bg-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-8 text-slate-400 hover:text-slate-600 p-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {shortcutBadge && (
        <span className="absolute right-2.5 px-1 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-mono font-bold border border-slate-200 pointer-events-none">
          {shortcutBadge}
        </span>
      )}
    </div>
  );
};
