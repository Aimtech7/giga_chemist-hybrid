import { useEffect, useRef } from 'react';

interface BarcodeScannerOptions {
  onScan: (barcode: string) => void;
  minChars?: number;
  maxIntervalMs?: number;
  enabled?: boolean;
}

export function useBarcodeScanner({
  onScan,
  minChars = 4,
  maxIntervalMs = 60,
  enabled = true,
}: BarcodeScannerOptions) {
  const bufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't intercept if user is typing inside standard inputs unless it's fast scanner input
      const target = event.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      const now = Date.now();
      const interval = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (event.key === 'Enter') {
        if (bufferRef.current.length >= minChars) {
          event.preventDefault();
          onScan(bufferRef.current.trim());
          bufferRef.current = '';
        }
        return;
      }

      // Reset buffer if typing is too slow (user typing manually on keyboard)
      if (interval > maxIntervalMs && !isInput) {
        bufferRef.current = '';
      }

      // Append printable single characters
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // If not in input, accumulate
        if (!isInput) {
          bufferRef.current += event.key;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onScan, minChars, maxIntervalMs, enabled]);
}
