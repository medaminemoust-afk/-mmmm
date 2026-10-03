import { useEffect, useState } from 'react';

export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? initial; }
    catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Keep the app usable when browser storage is unavailable. */ }
  }, [key, value]);
  return [value, setValue] as const;
}