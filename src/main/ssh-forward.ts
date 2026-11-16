import { createServer, type Socket } from 'node:net';
import type { Client } from 'ssh2';

export class LocalForward {
  private sockets = new Set<Socket>();
  private cancel = new AbortController();
  private server;

  constructor(client: Client, host: string, port: number, report: (error: Error) => void) {
    this.server = createServer({ pauseOnConnect: true }, socket => {
      this.sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => this.sockets.delete(socket));
      try {
        client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (error, channel) => {
          if (error) { report(error); socket.destroy(); return; }
          if (socket.destroyed) { channel.destroy(); return; }
          channel.on('error', () => socket.destroy());
          socket.once('close', () => channel.destroy());
          channel.pipe(socket).pipe(channel);
        });
      } catch (error) {
        socket.destroy();
        if (error instanceof Error) report(error);
      }
    });
    this.server.on('error', report);
  }

  async start(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        this.server.off('listening', ready);
        this.server.off('error', failed);
        this.server.off('close', stopped);
      };
      const ready = () => { clear(); resolve(); };
      const failed = (error: Error) => { clear(); reject(error); };
      const stopped = () => failed(new Error('SSH 转发已关闭'));
      this.server.once('listening', ready);
      this.server.once('error', failed);
      this.server.once('close', stopped);
      this.server.listen({ host: '127.0.0.1', port, signal: this.cancel.signal });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('SSH 转发监听失败');
    return address.port;
  }

  close() {
    this.cancel.abort();
    for (const socket of this.sockets) socket.destroy();
  }
}
