import { createFrickMcpServer, type FrickMcpOptions, type JsonRpcMessage, type JsonRpcResponse } from "./server.js";

export interface FrickMcpStdioStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function writeResponse(stdout: NodeJS.WritableStream, response: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function parseMessage(line: string): JsonRpcMessage {
  return JSON.parse(line) as JsonRpcMessage;
}

export function runFrickMcpStdio(
  options: FrickMcpOptions,
  streams: FrickMcpStdioStreams = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): void {
  const server = createFrickMcpServer(options);
  let buffer = "";

  streams.stdin.setEncoding("utf8");
  streams.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let message: JsonRpcMessage;
        try {
          message = parseMessage(line);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          writeResponse(streams.stdout, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error", data: detail },
          });
          newline = buffer.indexOf("\n");
          continue;
        }
        void server
          .handle(message)
          .then((response) => {
            if (response) writeResponse(streams.stdout, response);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            writeResponse(streams.stdout, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message },
            });
          });
      }
      newline = buffer.indexOf("\n");
    }
  });

  streams.stdin.on("error", (error) => {
    streams.stderr.write(`[frick-mcp] stdin error: ${error.message}\n`);
  });
}
