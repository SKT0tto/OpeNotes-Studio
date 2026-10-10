import fs from 'node:fs/promises';

/** Windows reports EPERM / EBUSY / EACCES for a moment while another request has the file open (rename over a file being read, antivirus scans). */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function retry<T>(op: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}

/** `fs.rename` that survives a short-lived lock on the destination. */
export const renameRetry = (from: string, to: string): Promise<void> => retry(() => fs.rename(from, to));
/** `fs.readFile` (utf8) that survives a short-lived lock. */
export const readTextRetry = (file: string): Promise<string> => retry(() => fs.readFile(file, 'utf8'));
