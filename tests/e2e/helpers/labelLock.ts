import fs from 'node:fs';
import path from 'node:path';

const LOCK = path.resolve('data-test', 'labels.lock');

/** The label file is shared by every spec that edits it: they take turns (a stale lock of a crashed worker is broken after 10 minutes). */
export async function acquireLabelLock(): Promise<void> {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      return;
    } catch {
      const age = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 600_000) fs.rmSync(LOCK, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export function releaseLabelLock(): void {
  fs.rmSync(LOCK, { recursive: true, force: true });
}
