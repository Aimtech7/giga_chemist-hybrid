import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Pill, Check, X, Layers, AlertCircle, ChevronDown } from 'lucide-react';
import { searchMedicines } from '../../services/searchEngine';
import type { Medicine, MedicineBatch } from '../../types';

export interface MedicineSelectorProps {
  medicines: Medicine[];
  batches?: MedicineBatch[];
  selectedMedicineId?: string | null;
  onSelect: (medicine: Medicine | null) => void;
  placeholder?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  showStock?: boolean;
  showPrice?: boolean;
  currency?: string;
}

export const MedicineSelector: React.FC<MedicineSelectorProps> = ({
  medicines,
  batches,
  selectedMedicineId,
  onSelect,
  placeholder = 'Search by name, generic, brand, strength, SKU, or barcode...',
  label,
  required = false,
  disabled = false,
  autoFocus = false,
  className = '',
  showStock = true,
  showPrice = true,
  currency = 'KES',
}) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedMedicine = useMemo(() => {
    if (!selectedMedicineId) return null;
    return medicines.find((m) => m.id === selectedMedicineId) || null;
  }, [selectedMedicineId, medicines]);

  const results = useMemo(() => {
    if (!query.trim()) {
      return medicines.slice(0, 50);
    }
    return searchMedicines(query, medicines, batches).slice(0, 50);
  }, [query, medicines, batches]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset highlighted index on query change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (isOpen && listRef.current && listRef.current.children[highlightedIndex]) {
      const item = listRef.current.children[highlightedIndex] as HTMLElement;
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setHighlightedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
      }
    } else if (e.key === 'Enter') {
      if (isOpen && results.length > 0) {
        e.preventDefault();
        const selected = results[highlightedIndex];
        if (selected) {
          onSelect(selected);
          setIsOpen(false);
          setQuery('');
        }
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(null);
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {label && (
        <label className="block text-xs font-bold text-slate-700 mb-1">
          {label} {required && <span className="text-rose-500">*</span>}
        </label>
      )}

      {selectedMedicine && !isOpen ? (
        <div
          onClick={() => {
            if (!disabled) {
              setIsOpen(true);
              setTimeout(() => inputRef.current?.focus(), 50);
            }
          }}
          className={`w-full p-2 bg-slate-50 border border-slate-300 rounded flex items-center justify-between gap-2 text-xs cursor-pointer hover:bg-slate-100 transition ${
            disabled ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Pill className="w-4 h-4 text-teal-700 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-slate-900 truncate">
                {selectedMedicine.name}{' '}
                {selectedMedicine.dosage_strength && (
                  <span className="text-slate-500 font-normal">({selectedMedicine.dosage_strength})</span>
                )}
              </div>
              <div className="text-[10px] text-slate-500 truncate flex items-center gap-2">
                <span>{selectedMedicine.generic_name}</span>
                {selectedMedicine.sku && <span className="font-mono text-slate-400">SKU: {selectedMedicine.sku}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {showStock && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono ${
                  selectedMedicine.current_stock > 0
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-rose-100 text-rose-800'
                }`}
              >
                {selectedMedicine.current_stock} in stock
              </span>
            )}
            {showPrice && (
              <span className="font-bold font-mono text-slate-900 text-xs">
                {currency} {selectedMedicine.selling_price.toFixed(2)}
              </span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={handleClear}
                className="text-slate-400 hover:text-rose-600 p-0.5 rounded"
                title="Clear selection"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            className="w-full pl-9 pr-8 py-2 border border-slate-300 rounded text-xs text-slate-900 bg-white placeholder-slate-400 focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <ChevronDown className="w-4 h-4 absolute right-2.5 top-2.5 text-slate-400 pointer-events-none" />
          )}
        </div>
      )}

      {/* Results Dropdown */}
      {isOpen && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white rounded border border-slate-300 shadow-xl max-h-72 overflow-hidden flex flex-col animate-in fade-in-50 duration-100">
          <div className="px-3 py-1.5 bg-slate-100 border-b border-slate-200 text-[10px] text-slate-500 font-semibold flex justify-between items-center">
            <span>
              {results.length} medicine{results.length === 1 ? '' : 's'} found
            </span>
            <span className="font-mono">Use ↑↓ keys, Enter to select</span>
          </div>

          <ul ref={listRef} className="overflow-y-auto divide-y divide-slate-100 flex-1">
            {results.length === 0 ? (
              <li className="p-4 text-center text-slate-400 text-xs">
                <AlertCircle className="w-5 h-5 mx-auto mb-1 text-slate-300" />
                No medicines found matching "{query}"
              </li>
            ) : (
              results.map((med, idx) => {
                const isSelected = med.id === selectedMedicineId;
                const isHighlighted = idx === highlightedIndex;

                return (
                  <li
                    key={med.id}
                    onClick={() => {
                      onSelect(med);
                      setIsOpen(false);
                      setQuery('');
                    }}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className={`p-2.5 flex items-center justify-between gap-3 text-xs cursor-pointer transition ${
                      isHighlighted
                        ? 'bg-teal-50 text-teal-950'
                        : isSelected
                        ? 'bg-slate-50 text-slate-900'
                        : 'text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold">{med.name}</span>
                        {med.dosage_strength && (
                          <span className="text-[11px] text-slate-500">
                            {med.dosage_strength}
                          </span>
                        )}
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-teal-700 inline shrink-0" />
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                        <span>{med.generic_name}</span>
                        {med.brand_name && <span>· {med.brand_name}</span>}
                        {med.barcode && (
                          <span className="font-mono text-[10px] text-slate-400">
                            Bar: {med.barcode}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {showPrice && (
                        <div className="font-bold font-mono text-slate-900">
                          {currency} {med.selling_price.toFixed(2)}
                        </div>
                      )}
                      {showStock && (
                        <div
                          className={`text-[10px] font-mono font-semibold ${
                            med.current_stock <= 0
                              ? 'text-rose-600'
                              : med.current_stock <= med.reorder_level
                              ? 'text-amber-600'
                              : 'text-emerald-700'
                          }`}
                        >
                          {med.current_stock} {med.unit || 'units'}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
};
