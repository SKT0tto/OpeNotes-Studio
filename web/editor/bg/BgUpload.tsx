import { useRef, useState } from 'react';
import { UPLOAD_MIN_SIDE, ignoredFilesNotice, uploadTargetSize } from '@shared/catalog/uploadBg';
import { uploadBackground } from '../../setup/setupApi';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const EXT_OK = /\.(png|jpe?g|webp)$/i;
const TYPE_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Decode, shrink (never enlarge) and re-encode to an 8-bit non-interlaced PNG. */
async function normalise(file: File): Promise<Blob> {
  if (!TYPE_OK.has(file.type) && !EXT_OK.test(file.name)) throw new Error('不支持的格式（仅 PNG / JPG / WebP）');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('图片无法读取');
  }
  try {
    if (bmp.width < UPLOAD_MIN_SIDE || bmp.height < UPLOAD_MIN_SIDE) throw new Error(`图片太小（至少 ${UPLOAD_MIN_SIDE}×${UPLOAD_MIN_SIDE}）`);
    const { width, height } = uploadTargetSize(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片无法读取');
    ctx.drawImage(bmp, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('图片无法读取');
    return blob;
  } finally {
    bmp.close();
  }
}

export interface BgUploader {
  busy: boolean;
  /** Progress line while uploading, the summary afterwards. */
  status: string;
  errors: string[];
  upload: (files: File[]) => Promise<void>;
}

/** Upload pictures one by one; `onUploaded` gets the ids that are now in the library (new or already there). */
export function useBgUpload(onUploaded: (ids: string[]) => void): BgUploader {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const lock = useRef(false);
  const upload = async (files: File[]) => {
    if (lock.current) return;
    const isImage = (f: File) => f.type.startsWith('image/') || EXT_OK.test(f.name);
    const list = files.filter(isImage);
    const ignored = ignoredFilesNotice(files.filter((f) => !isImage(f)).map((f) => f.name));
    if (list.length === 0) {
      if (ignored) { setErrors([]); setStatus(ignored); }
      return;
    }
    lock.current = true;
    setBusy(true);
    setErrors([]);
    const ids: string[] = [];
    const errs: string[] = [];
    let added = 0;
    let dup = 0;
    for (const [i, f] of list.entries()) {
      setStatus(`正在上传 ${i + 1}/${list.length}：${f.name}`);
      try {
        const r = await uploadBackground(await normalise(f), f.name);
        ids.push(r.id);
        if (r.status === 'new') added++;
        else dup++;
      } catch (e) {
        errs.push(`${f.name}：${(e as Error).message}`);
      }
    }
    setStatus([[added > 0 ? `已添加 ${added} 张` : '', dup > 0 ? `${dup} 张已在素材库中` : '', errs.length > 0 && ids.length === 0 ? '没有图片被添加' : ''].filter(Boolean).join('，'), ignored].filter(Boolean).join('。'));
    setErrors(errs);
    if (ids.length > 0) onUploaded(ids);
    setBusy(false);
    lock.current = false;
  };
  return { busy, status, errors, upload };
}

export function BgUploadButton({ up }: { up: BgUploader }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn" disabled={up.busy} onClick={() => input.current?.click()} title="从电脑添加自己的背景图片（PNG / JPG / WebP），上传后可直接选用" data-testid="bg-upload-button">上传背景</button>
      <input
        ref={input} type="file" multiple accept={ACCEPT} hidden data-testid="bg-upload-input"
        onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; void up.upload(fs); }}
      />
    </>
  );
}

/** Status line + per-file errors (renders nothing until something happened). */
export function BgUploadStatus({ up }: { up: BgUploader }) {
  if (!up.status && up.errors.length === 0) return null;
  return (
    <div className="bgx-upstatus" data-testid="bg-upload-status" role="status">
      {up.status && <div>{up.status}</div>}
      {up.errors.map((e, i) => <div key={i} className="err">{e}</div>)}
    </div>
  );
}

/** Drag-and-drop of image files onto a container; ignores drags that carry no files. */
export function useBgDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      onFiles([...e.dataTransfer.files]);
    },
  };
  return { dragging, handlers };
}

export function BgDropOverlay({ show }: { show: boolean }) {
  return show ? <div className="bgx-dropveil" data-testid="bg-drop-overlay">松开以上传背景（PNG / JPG / WebP）</div> : null;
}
