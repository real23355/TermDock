import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createController } from './controller';
import { errorText, type SerialProvider } from './session';

const message = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), id: z.number().int().positive(), name: z.string(), args: z.array(z.unknown()) }),
  z.object({ kind: z.literal('notify'), name: z.string(), args: z.array(z.unknown()) }),
  z.object({ kind: z.literal('quit') }),
]);

export function startWorker(directory: string, serial?: SerialProvider) {
  const send = (packet: object) => process.stdout.write(JSON.stringify(packet) + '\n');
  const controller = createController(directory, event => {
    const payload = event.type === 'output' ? { ...event, data: Buffer.from(event.data).toString('base64') } : event;
    send({ kind: 'event', event: payload });
  }, serial);
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    reader.close();
    process.stdin.pause();
    await controller.closeAll();
  }
  reader.on('line', async line => {
    if (closing) return;
    let packet: z.infer<typeof message>;
    try { packet = message.parse(JSON.parse(line)); }
    catch { return; }
    if (packet.kind === 'quit') { await close(); return; }
    if (packet.kind === 'notify') {
      if (Object.hasOwn(controller.notifications, packet.name)) controller.notifications[packet.name](...packet.args);
      return;
    }
    try {
      if (!Object.hasOwn(controller.requests, packet.name)) throw new Error('请求无效');
      const value = await controller.requests[packet.name](...packet.args);
      send({ kind: 'reply', id: packet.id, ok: true, value });
    } catch (error) {
      const detail = error instanceof z.ZodError ? error.issues[0]?.message : errorText(error);
      send({ kind: 'reply', id: packet.id, ok: false, error: detail });
    }
  });
  reader.on('close', () => { void close(); });
}
