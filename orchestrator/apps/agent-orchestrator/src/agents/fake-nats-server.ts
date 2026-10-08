import net from "node:net";

/**
 * Minimal NATS wire-protocol server — enough of it (INFO/CONNECT handshake,
 * PING/PONG, SUB/UNSUB, PUB fanout) to run a real nats.js client against a
 * real socket, and crucially to be killed and restarted on demand.
 *
 * Test-only, and deliberately not a general NATS implementation: it exists so
 * `nats-agent-channel.integration.test.ts` can observe genuine client
 * reconnect and subscription-timeout behavior, which is where the production
 * defect actually lived. A faked `NatsConnection` cannot show that.
 */
export class FakeNatsServer {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  /** sid -> subscription, mirroring what the client has told us it wants. */
  private readonly subs = new Map<string, { socket: net.Socket; subject: string }>();
  private subWaiters: Array<() => void> = [];
  port: number;

  constructor(port = 0) {
    this.port = port;
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {
          /* client went away mid-write; nothing to do */
        });
        socket.write(
          `INFO ${JSON.stringify({
            server_id: "FAKE",
            server_name: "FAKE",
            version: "2.10.0",
            proto: 1,
            host: "127.0.0.1",
            port: this.port,
            headers: false,
            max_payload: 1048576,
            tls_required: false,
          })}\r\n`,
        );
        let buf: Buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buf = this.consume(socket, Buffer.concat([buf, chunk]) as Buffer);
        });
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        this.port = (this.server!.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  private consume(socket: net.Socket, buf: Buffer): Buffer {
    for (;;) {
      const nl = buf.indexOf("\r\n");
      if (nl === -1) return buf;
      const line = buf.subarray(0, nl).toString();
      const op = line.toUpperCase();

      if (op.startsWith("PUB ")) {
        // PUB <subject> [reply] <#bytes>\r\n<payload>\r\n
        const parts = line.split(/\s+/);
        const nbytes = Number(parts[parts.length - 1]);
        const need = nl + 2 + nbytes + 2;
        if (buf.length < need) return buf; // payload not fully arrived yet
        this.fanout(parts[1]!, buf.subarray(nl + 2, nl + 2 + nbytes));
        buf = buf.subarray(need);
        continue;
      }

      buf = buf.subarray(nl + 2);
      if (op === "PING") {
        socket.write("PONG\r\n");
      } else if (op.startsWith("SUB ")) {
        const [, subject, sid] = line.split(/\s+/);
        this.subs.set(sid!, { socket, subject: subject! });
        const waiters = this.subWaiters;
        this.subWaiters = [];
        for (const w of waiters) w();
      } else if (op.startsWith("UNSUB ")) {
        this.subs.delete(line.split(/\s+/)[1]!);
      }
    }
  }

  private fanout(subject: string, payload: Buffer): void {
    for (const [sid, sub] of this.subs) {
      if (sub.subject !== subject) continue;
      sub.socket.write(`MSG ${subject} ${sid} ${payload.length}\r\n`);
      sub.socket.write(payload);
      sub.socket.write("\r\n");
    }
  }

  /**
   * Resolves once the client has registered at least one subscription. nats.js
   * buffers SUB, so publishing before this races the subscription into
   * existence and silently drops the message.
   */
  async flushed(): Promise<void> {
    if (this.subs.size > 0) return;
    await new Promise<void>((resolve) => this.subWaiters.push(resolve));
  }

  /** Publishes as if from the agent side. */
  publish(subject: string, obj: unknown): void {
    this.fanout(subject, Buffer.from(JSON.stringify(obj)));
  }

  /** Hard outage: drop every connection and stop listening. */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.subs.clear();
    if (!this.server?.listening) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  get url(): string {
    return `nats://127.0.0.1:${this.port}`;
  }
}
