import React, { useEffect, useRef, useState } from 'react';

/**
 * Minimal windowing for long uniform lists (thousands of rows): only the rows in view (+ overscan) are
 * mounted, while the scrollbar spans the whole dataset. Rows must have a fixed height.
 */
export function VirtualRows<T>({ items, rowHeight, height, overscan = 12, render, header, minWidth, className }: {
  items: T[];
  rowHeight: number;
  height: number | string;
  overscan?: number;
  render: (item: T, index: number) => React.ReactNode;
  header?: React.ReactNode;
  /** Wide tables scroll horizontally inside the same box (tablets). */
  minWidth?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [view, setView] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setView(el.clientHeight || 600);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  // A new result set starts at the top (search / filter / sort changed).
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setTop(0);
  }, [items]);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(items.length, Math.ceil((top + view) / rowHeight) + overscan);
  return (
    <div ref={ref} onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)} className={`overflow-auto ${className || ''}`} style={{ height }}>
      <div style={{ minWidth }}>
        {header}
        <div style={{ height: items.length * rowHeight, position: 'relative' }}>
          {items.slice(first, last).map((it, i) => (
            <div key={first + i} style={{ position: 'absolute', top: (first + i) * rowHeight, left: 0, right: 0, height: rowHeight }}>
              {render(it, first + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
