"""MSYS2 POSIX PTY for the loopback SSH fixture. stdin carries framed input and sizes."""

import errno
import fcntl
import os
import pty
import signal
import struct
import sys
import termios
import threading


def resize(fd, size):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


def forward_input(master, child):
    try:
        while header := sys.stdin.buffer.read(5):
            operation, length = struct.unpack('<BI', header)
            payload = sys.stdin.buffer.read(length)
            if operation == 1:
                while payload:
                    payload = payload[os.write(master, payload):]
            elif operation == 2:
                resize(master, payload)
    finally:
        try:
            os.kill(child, signal.SIGHUP)
        except ProcessLookupError:
            pass


rows, cols, width, height = map(int, sys.argv[1:5])
gate_read, gate_write = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(gate_write)
    os.read(gate_read, 1)
    os.close(gate_read)
    os.execvp(sys.argv[5], sys.argv[5:])

os.close(gate_read)
resize(master, struct.pack('<HHHH', rows, cols, width, height))
os.write(gate_write, b'1')
os.close(gate_write)
threading.Thread(target=forward_input, args=(master, pid), daemon=True).start()
try:
    while data := os.read(master, 65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
except OSError as error:
    if error.errno != errno.EIO:
        raise
finally:
    os.close(master)
_, status = os.waitpid(pid, 0)
os._exit(os.waitstatus_to_exitcode(status))
