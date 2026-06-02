/**
 * Blob upload React surface.
 *
 * Wraps `uploadImageAttachment` from `./chat-foundation.js` into an
 * ergonomic hook + drop-target component. Adds optional client-side
 * image compression via `createImageBitmap` + `OffscreenCanvas` so the
 * caller doesn't have to thread blob processing through their own code.
 *
 * `<FileDropzone onUpload>` is the drag-and-drop entry; also accepts
 * paste-from-clipboard via `usePasteImageUpload`. Both ultimately call
 * the same `useUploadBlob` hook so a single upload pipeline handles
 * paste, drop, and explicit-input cases.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { uploadImageAttachment, type AttachmentMetadata } from "./chat-foundation.js";
import { useFrick, useFrickHttpEndpoint, useFrickSession } from "@fricken/react";

export interface UploadOptions {
  /**
   * If provided AND the file is an image, compress to at most this
   * dimension (preserving aspect ratio) before upload. Skips compression
   * for non-image MIME types.
   */
  readonly maxDimension?: number;
  /** JPEG quality 0..1 when re-encoding. Defaults to 0.85. */
  readonly quality?: number;
}

/**
 * Returns a stable uploader. Resolves with the server's
 * `AttachmentMetadata` (including the `blobId` to reference in stream
 * event payloads).
 */
export function useUploadBlob(): (
  file: File,
  options?: UploadOptions,
) => Promise<AttachmentMetadata> {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const session = useFrickSession();
  return useCallback(
    async (file, options) => {
      const compressed = options?.maxDimension && file.type.startsWith("image/")
        ? await compressImage(file, options.maxDimension, options.quality ?? 0.85)
        : file;
      return uploadImageAttachment({
        httpEndpoint,
        file: compressed,
        ownerId: session?.userId ?? client.session?.userId ?? "",
        sessionToken: session?.sessionToken ?? client.sessionToken,
      });
    },
    [client, httpEndpoint, session],
  );
}

export interface FileDropzoneProps {
  readonly children?: ReactNode;
  readonly onUpload: (metadata: AttachmentMetadata) => void;
  readonly onError?: (error: Error) => void;
  readonly accept?: string;
  readonly options?: UploadOptions;
  readonly disabled?: boolean;
}

/**
 * Drag-and-drop zone. Renders its children with `data-frick-active` set
 * to `"true"` while a drag is hovering, so consumers can style the
 * highlight however they want. No built-in CSS opinions.
 */
export function FileDropzone({ children, onUpload, onError, accept, options, disabled }: FileDropzoneProps) {
  const upload = useUploadBlob();
  const [active, setActive] = useState(false);

  const handleDrop = useCallback(
    async (event: DragEvent) => {
      event.preventDefault();
      setActive(false);
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      for (const file of files) {
        if (accept && !file.type.match(accept)) continue;
        try {
          const metadata = await upload(file, options);
          onUpload(metadata);
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
    [accept, disabled, onError, onUpload, options, upload],
  );

  return (
    <div
      data-frick-active={active}
      onDragEnter={() => setActive(true)}
      onDragLeave={() => setActive(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}

/**
 * Attach a paste-image handler to the window. On Cmd-V (or Ctrl-V) of an
 * image, calls `onUpload` with the resulting `AttachmentMetadata`.
 */
export function usePasteImageUpload(options: {
  onUpload: (metadata: AttachmentMetadata) => void;
  onError?: (error: Error) => void;
  compression?: UploadOptions;
  disabled?: boolean;
}): void {
  const upload = useUploadBlob();
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (options.disabled) return;
    const handler = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        void (async () => {
          try {
            const metadata = await upload(file, optsRef.current.compression);
            optsRef.current.onUpload(metadata);
          } catch (err) {
            optsRef.current.onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      }
    };
    globalThis.addEventListener("paste", handler);
    return () => globalThis.removeEventListener("paste", handler);
  }, [options.disabled, upload]);
}

/**
 * Compress an image File to at most `maxDimension` (preserving aspect)
 * and re-encode as JPEG. Uses `createImageBitmap` + `OffscreenCanvas` so
 * the work happens off the main thread when the browser supports it.
 *
 * Returns the original file when the runtime lacks the required APIs
 * (older browsers, SSR shims) — the upload still succeeds, it just isn't
 * compressed.
 */
async function compressImage(file: File, maxDimension: number, quality: number): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    if (ratio >= 1) {
      bitmap.close();
      return file;
    }
    const width = Math.round(bitmap.width * ratio);
    const height = Math.round(bitmap.height * ratio);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  }
}
