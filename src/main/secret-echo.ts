// Match device echo across serial reads. Other bytes retain their original encoding.
export class SecretEchoFilter {
  private key: Buffer;
  private pending: Buffer = Buffer.alloc(0);
  constructor(secret: string) { this.key = Buffer.from(secret, 'utf8'); }

  filter(chunk: Buffer) {
    const bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let start = 0;
    const parts: Buffer[] = [];
    for (let index = bytes.indexOf(this.key); index >= 0; index = bytes.indexOf(this.key, start)) {
      parts.push(bytes.subarray(start, index), Buffer.alloc(this.key.length, 0x2a));
      start = index + this.key.length;
    }
    let prefix = Math.min(this.key.length - 1, bytes.length - start);
    while (prefix && !bytes.subarray(bytes.length - prefix).equals(this.key.subarray(0, prefix))) prefix--;
    this.pending = bytes.subarray(bytes.length - prefix);
    const output = bytes.subarray(start, bytes.length - prefix);
    return parts.length ? Buffer.concat([...parts, output]) : output;
  }

  finish() {
    const tail = Buffer.alloc(this.pending.length, 0x2a);
    this.key.fill(0);
    this.pending = Buffer.alloc(0);
    return tail;
  }
}
