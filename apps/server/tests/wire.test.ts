import { describe, expect, it } from "vitest";
import { FrameKind, foundationSchema } from "@fricken/protocol";
import { sendFrame } from "../src/sync/wire.js";

describe("sync wire outbound backpressure", () => {
  it("closes and skips websocket sends when the outbound buffer is over the limit", () => {
    const calls: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 11,
      send: () => calls.push("send"),
      close: (code: number, reason: string) => calls.push(`close:${code}:${reason}`),
      terminate: () => calls.push("terminate"),
    };

    const sent = sendFrame(socket as never, [FrameKind.Schema, foundationSchema], {
      maxBufferedAmount: 10,
    });

    expect(sent).toBe(false);
    expect(calls).toEqual(["close:1013:WebSocket outbound buffer exceeded"]);
  });
});
