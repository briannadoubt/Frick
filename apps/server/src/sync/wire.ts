import type { WebSocket } from "ws";
import { encodeFrame, type FrickFrame } from "@fricken/protocol";

export interface SendFrameOptions {
  maxBufferedAmount?: number;
}

export function sendFrame(socket: WebSocket, frame: FrickFrame, options: SendFrameOptions = {}): boolean {
  if (socket.readyState !== 1) {
    return false;
  }
  const encoded = encodeFrame(frame);
  if (
    options.maxBufferedAmount !== undefined &&
    socket.bufferedAmount + encoded.byteLength > options.maxBufferedAmount
  ) {
    closeBackpressuredSocket(socket);
    return false;
  }
  socket.send(encoded);
  if (
    options.maxBufferedAmount !== undefined &&
    socket.bufferedAmount > options.maxBufferedAmount
  ) {
    closeBackpressuredSocket(socket);
    return false;
  }
  return true;
}

function closeBackpressuredSocket(socket: WebSocket): void {
  try {
    socket.close(1013, "WebSocket outbound buffer exceeded");
  } catch {
    socket.terminate();
  }
}
