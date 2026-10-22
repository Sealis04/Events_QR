import { createServer, request as httpRequest, type Server } from "node:http";
import type { Socket } from "node:net";

export type ProxyMode = "up" | "down" | "hang";

/**
 * A tiny HTTP proxy the tests can switch: `up` forwards, `down` drops connections (like a dead
 * link), `hang` accepts the request and never answers (the case the 800 ms hub timeout is for).
 */
export class SwitchProxy {
  mode: ProxyMode = "up";
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(
    private readonly port: number,
    private readonly target: number,
  ) {
    this.server = createServer((req, res) => {
      if (this.mode === "down") return void req.socket.destroy();
      if (this.mode === "hang") return; // never answers; the client gives up
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: this.target,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
