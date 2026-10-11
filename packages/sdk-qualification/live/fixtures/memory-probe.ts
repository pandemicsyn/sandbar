export const processAbsent = `python3 -c 'import errno,socket
s=socket.socket(socket.AF_UNIX);s.settimeout(1)
try:
 s.connect("/tmp/sandbar-memory.sock");print("PROCESS_PRESENT")
except OSError as e:
 if e.errno not in (errno.ENOENT,errno.ECONNREFUSED,errno.ECONNRESET): raise
 print("PROCESS_ABSENT")
finally: s.close()'`;

export const memoryProgram = `import os,socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.bind('/tmp/sandbar-memory.sock')
s.listen(2)
s.settimeout(240)
nonce=os.urandom(16).hex()
count=0
while True:
 c,_=s.accept()
 count+=1
 c.sendall((nonce+':'+str(count)).encode())
 c.close()
`;

export const memoryRead = `python3 -c 'import socket;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(3);s.connect("/tmp/sandbar-memory.sock");print(s.recv(128).decode());s.close()'`;

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function memorySample(value: string) {
  const match = /^([0-9a-f]{32}):(\d+)\n$/.exec(value);

  if (!match) throw new Error("Missing bounded memory observation");

  return { nonce: match[1]!, count: Number(match[2]) };
}
