/**
 * Voice + video memo hooks.
 *
 * Wraps the browser's `MediaRecorder` into a `start()/stop()` pair that
 * resolves with an `AttachmentMetadata` blob uploaded through the
 * existing blob pipeline. The recording itself is a `Blob` (audio/webm
 * for voice, video/webm for video) packaged as a `File` and uploaded via
 * the same `useUploadBlob` hook used by drop, paste, and explicit input.
 *
 * Consumers typically wire `stop()` to a UI element that also appends a
 * stream event referencing the resulting `blobId`. The hook does NOT
 * append automatically — keeping audio capture and event authorship
 * separate lets a consumer cancel mid-recording without leaving an
 * orphan event in the conversation.
 *
 * No tests in this commit: `MediaRecorder`, `getUserMedia`, and
 * `OffscreenCanvas` aren't available in node/jsdom and a fake adds
 * weight without exercising real behavior. The web demo's integration
 * is the validation surface.
 */

import { useCallback, useRef, useState } from "react";
import type { AttachmentMetadata } from "@frick/core/chat";
import { useUploadBlob, type UploadOptions } from "./blob.js";

export interface MediaRecorderControls {
  readonly state: "idle" | "recording" | "uploading";
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<AttachmentMetadata | null>;
  readonly cancel: () => void;
  readonly error?: Error;
}

export interface VoiceMemoOptions {
  /** MIME type to request from MediaRecorder. Defaults to `audio/webm`. */
  readonly mimeType?: string;
  /** Maximum recording length in ms. Auto-stops on hit. Defaults to 5 minutes. */
  readonly maxDurationMs?: number;
}

export function useVoiceMemo(options: VoiceMemoOptions = {}): MediaRecorderControls {
  return useMediaRecorder({
    mediaConstraints: { audio: true, video: false },
    mimeType: options.mimeType ?? "audio/webm",
    filenameStem: "voice-memo",
    fileExtension: "webm",
    maxDurationMs: options.maxDurationMs ?? 5 * 60_000,
  });
}

export interface VideoMemoOptions {
  readonly mimeType?: string;
  readonly maxDurationMs?: number;
  readonly compression?: UploadOptions;
}

export function useVideoMemo(options: VideoMemoOptions = {}): MediaRecorderControls {
  return useMediaRecorder({
    mediaConstraints: { audio: true, video: true },
    mimeType: options.mimeType ?? "video/webm",
    filenameStem: "video-memo",
    fileExtension: "webm",
    maxDurationMs: options.maxDurationMs ?? 60_000,
  });
}

interface InternalOptions {
  readonly mediaConstraints: MediaStreamConstraints;
  readonly mimeType: string;
  readonly filenameStem: string;
  readonly fileExtension: string;
  readonly maxDurationMs: number;
}

function useMediaRecorder(opts: InternalOptions): MediaRecorderControls {
  const upload = useUploadBlob();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<MediaRecorderControls["state"]>("idle");
  const [error, setError] = useState<Error | undefined>();

  const teardownStream = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    setError(undefined);
    if (state === "recording" || typeof MediaRecorder === "undefined") {
      if (typeof MediaRecorder === "undefined") {
        setError(new Error("MediaRecorder is not available in this environment"));
      }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(opts.mediaConstraints);
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: opts.mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorderRef.current = recorder;
      recorder.start();
      setState("recording");
      stopTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, opts.maxDurationMs);
    } catch (err) {
      teardownStream();
      setState("idle");
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [opts, state, teardownStream]);

  const stop = useCallback(async (): Promise<AttachmentMetadata | null> => {
    const recorder = recorderRef.current;
    if (!recorder || state !== "recording") return null;
    setState("uploading");
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          try {
            resolve(new Blob(chunksRef.current, { type: opts.mimeType }));
          } catch (err) {
            reject(err);
          }
        };
        recorder.stop();
      });
      teardownStream();
      const file = new File([blob], `${opts.filenameStem}-${Date.now()}.${opts.fileExtension}`, {
        type: opts.mimeType,
      });
      const metadata = await upload(file);
      setState("idle");
      return metadata;
    } catch (err) {
      teardownStream();
      setState("idle");
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      return null;
    }
  }, [opts, state, teardownStream, upload]);

  const cancel = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped
      }
    }
    teardownStream();
    setState("idle");
  }, [teardownStream]);

  return error === undefined ? { state, start, stop, cancel } : { state, start, stop, cancel, error };
}
