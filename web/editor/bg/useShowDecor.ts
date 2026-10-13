import { useCallback, useEffect, useState } from 'react';

const KEY = 'ons.showDecor';
const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/** The "显示装饰素材" switch (logo / plain colour / UI pictures), remembered in this browser. */
export function useShowDecor(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const h = (e: StorageEvent) => {
      if (e.key === KEY) setOn(read());
    };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* private window: the switch just is not remembered */
    }
  }, []);
  return [on, set];
}
