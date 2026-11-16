import { app, dialog } from 'electron';
import { SerialPortMock } from 'serialport';
import { WriteStream } from 'node:fs';
import { startApp } from '../src/main/app';

let device: SerialPortMock;
const path = 'COM77';
SerialPortMock.binding.createPort(path, { record: true, manufacturer: 'TermDock mock' });

// Fault injection targets an actual WriteStream write in the backend.
const streamPrototype = WriteStream.prototype as any;
const write = streamPrototype._write;
const writev = streamPrototype._writev;
let fail = false;
// FileHandle-created streams have no path property. Target their first write containing the marker.
function failChunk(chunk: Buffer | { chunk: Buffer }[]) {
  return fail && (Array.isArray(chunk) ? chunk.some(value => value.chunk.includes('INJECT_DISK_FAILURE')) :
    chunk.includes('INJECT_DISK_FAILURE'));
}
streamPrototype._write = function (chunk: Buffer, encoding: string, done: (error?: Error) => void) {
  if (failChunk(chunk)) { fail = false; done(new Error('模拟磁盘空间不足')); }
  else write.call(this, chunk, encoding, done);
};
streamPrototype._writev = function (chunks: { chunk: Buffer }[], done: (error?: Error) => void) {
  if (failChunk(chunks)) { fail = false; done(new Error('模拟磁盘空间不足')); }
  else writev.call(this, chunks, done);
};

Object.assign(globalThis, {
  fixture: {
    feed: (bytes: number[]) => device.port!.emitData(Buffer.from(bytes)),
    sent: () => [...device.port!.recording],
    connected: () => device?.isOpen,
    disconnect: () => device.close(() => {}),
    diskFailure: () => { fail = true; device.port!.emitData(Buffer.from('INJECT_DISK_FAILURE\r\n')); },
    choosePath: (path: string) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    resize: (width: number, height: number) => {
      // The test uses the real BrowserWindow sizing path.
      require('electron').BrowserWindow.getAllWindows()[0].setSize(width, height);
    },
    quit: () => app.quit(),
  },
});
startApp({
  dataDirectory: process.env.TERMDOCK_TEST_DATA,
  serial: {
    list: () => SerialPortMock.list(),
    openDevice: config => {
      device = new SerialPortMock({ path: config.path, baudRate: config.baudRate, autoOpen: false });
      return device;
    },
  },
});
