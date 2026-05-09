import type { WebSocket } from "ws";
import { encodeFrame, type FrickFrame } from "@frick/protocol";

export function sendFrame(socket: WebSocket, frame: FrickFrame): void {
  if (socket.readyState === 1) {
    socket.send(encodeFrame(frame));
  }
}
