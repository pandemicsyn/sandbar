// One process-scoped Python supervisor. It exposes no network port and installs no service.
// The private socket directory is removed when the child exits after local detach.
export const processSupervisor = String.raw`
import base64,collections,errno,fcntl,json,os,pty,selectors,shutil,signal,socket,struct,subprocess,sys,termios,threading,time
cfg=json.loads(base64.b64decode(sys.argv[1]))
root=cfg['root']
generation=cfg.get('generation')
lease=cfg.get('lease')
parked=False
terminal=cfg.get('terminal')
master=None
try: os.mkdir(root,0o700)
except FileExistsError:
 if os.path.isfile(root+'/cancel'):
  # A setup cancellation may precede a delayed launch; never spawn that child.
  sys.exit(0)
 raise
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try: server.bind(root+'/control')
except Exception:
 server.close()
 if not os.path.isfile(root+'/cancel'): shutil.rmtree(root)
 raise
os.chmod(root+'/control',0o600)
server.listen(8)
lock=threading.Condition()
queue=collections.deque()
queued=0
detached=False
discard=False
ended=False
failure=None
child=None
last_request=time.monotonic()
final_ack=False
try:
 if os.path.isfile(root+'/cancel'):
  server.close()
  os.unlink(root+'/control')
  sys.exit(0)
 if terminal:
  master,slave=pty.openpty()
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',terminal['rows'],terminal['columns'],0,0))
  def setup_terminal():
   os.setsid()
   fcntl.ioctl(0,termios.TIOCSCTTY,0)
  try:
   child=subprocess.Popen(cfg['argv'],cwd=cfg.get('cwd'),env=dict(os.environ,**cfg.get('env',{})),stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup_terminal)
  finally: os.close(slave)
  child.stdin=os.fdopen(os.dup(master),'wb',buffering=0)
  child.stdout=os.fdopen(master,'rb',buffering=0)
  child.stderr=None
 else:
  child=subprocess.Popen(cfg['argv'],cwd=cfg.get('cwd'),env=dict(os.environ,**cfg.get('env',{})),stdin=subprocess.PIPE if cfg['pipe'] else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
except Exception:
 if master is not None and child is None: os.close(master)
 failure='Child launch failed'
ready=threading.Event()
def output():
 global queued,ended,failure
 try:
  if child is None: return
  sel=selectors.DefaultSelector()
  for name,pipe in [('stdout',child.stdout),('stderr',child.stderr)]:
   if pipe is None: continue
   os.set_blocking(pipe.fileno(),False)
   sel.register(pipe,selectors.EVENT_READ,name)
  while sel.get_map():
   with lock:
    while (queued>=65536 or len(queue)>=256) and not discard: lock.wait(0.1)
    room=16384 if discard else min(16384,65536-queued)
   for key,_ in sel.select(0.1):
    # One frame per iteration bounds admission even when both streams are readable.
    with lock:
     try: data=os.read(key.fileobj.fileno(),room)
     except OSError as error:
      if terminal and error.errno==errno.EIO: data=b''
      else: raise
     if not data:
      sel.unregister(key.fileobj)
      key.fileobj.close()
     elif not discard:
      queue.append((key.data,data)); queued+=len(data)
     lock.notify_all()
    break
  sel.close()
 except Exception:
  failure='Output observation failed'
 finally:
  with lock:
   ended=True
   lock.notify_all()
threading.Thread(target=output,daemon=True).start()
def handle(conn):
 global queued,detached,discard,last_request,final_ack,lease,parked
 acquired=False
 try:
  conn.settimeout(30)
  f=conn.makefile('rb')
  line=f.readline(100000)
  if len(line)>=100000 or not line.endswith(b'\n'): raise ValueError()
  req=json.loads(line)
  op=req['op']
  lock.acquire(); acquired=True
  with lock:
   if generation is not None and time.monotonic()-last_request>30:
    parked=True; discard=True; lease=None; queue.clear(); queued=0
   if generation is not None and req.get('generation')!=generation: raise ValueError('generation')
   if op=='hello':
    if not parked or detached: raise ValueError('attachment busy')
    lease=req['nextLease']; parked=False; discard=False
   elif generation is not None and (parked or req.get('lease')!=lease): raise ValueError('stale attachment')
   last_request=time.monotonic()
  if failure and child is None: result={'error':failure}
  elif op=='read':
   with lock:
    if not queue and not ended and not discard: lock.wait(0.1)
    if generation is not None and (parked or req.get('lease')!=lease): raise ValueError()
    frames=[]
    size=0
    while queue and len(frames)<3 and size+len(queue[0][1])<=49152:
     name,data=queue.popleft(); size+=len(data); queued-=len(data)
     frames.append({'stream':name,'data':base64.b64encode(data).decode()})
    result={'frames':frames,'done':ended and not queue,'exitCode':child.poll(),'error':failure}
    lock.notify_all()
  elif op=='hello': result={'ok':True,'exitCode':child.poll()}
  elif op=='status': result={'exitCode':child.poll()}
  elif op=='write':
   data=base64.b64decode(req['data'],validate=True)
   if len(data)>65536: raise ValueError()
   if child.stdin is None or child.stdin.closed: raise ValueError()
   os.set_blocking(child.stdin.fileno(),False)
   view=memoryview(data)
   delivery_deadline=time.monotonic()+28
   while view:
    if generation is not None and (parked or req.get('lease')!=lease): raise ValueError()
    if time.monotonic()>delivery_deadline: raise TimeoutError()
    try:
     n=os.write(child.stdin.fileno(),view)
     view=view[n:]
    except BlockingIOError: lock.wait(0.01)
   result={'ok':True}
  elif op=='close':
   if terminal: raise ValueError('Terminal input has no pipe EOF')
   if child.stdin is not None and not child.stdin.closed: child.stdin.close()
   result={'ok':True}
  elif op=='terminate':
   # No poll/reap can race this syscall under the control lock: an unreaped child owns its PID.
   exit_code=child.poll()
   requested=False
   if exit_code is None:
    try: os.kill(child.pid,signal.SIGKILL); requested=True
    except ProcessLookupError: exit_code=child.poll()
   result={'ok':True,'status':'requested' if requested else 'not-found','exitCode':exit_code}
  elif op=='signal':
   if req['signal'] not in ('SIGTERM','SIGKILL'): raise ValueError()
   with lock:
    if generation is not None and (parked or req.get('lease')!=lease): raise ValueError()
    exit_code=child.poll()
    requested=False
    if exit_code is None:
     try: os.kill(child.pid,getattr(signal,req['signal'])); requested=True
     except ProcessLookupError: exit_code=child.poll()
   result={'ok':True,'status':'requested' if requested else 'not-found','exitCode':exit_code}
  elif op=='resize':
   if not terminal: raise ValueError()
   with lock:
    if generation is not None and (parked or req.get('lease')!=lease): raise ValueError()
    fcntl.ioctl(child.stdin.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',req['rows'],req['columns'],0,0))
   result={'ok':True}
  elif op in ('detach','discard','disconnect'):
   with lock:
    discard=True; queue.clear(); queued=0
    if op=='detach': detached=True
    if op=='disconnect': parked=True; lease=None
    lock.notify_all()
   if op=='detach' and child.stdin is not None and not child.stdin.closed: child.stdin.close()
   result={'ok':True}
  else: raise ValueError()
  conn.sendall(json.dumps(result,separators=(',',':')).encode()+b'\n')
  if op=='read' and result.get('done') and result.get('exitCode') is not None: final_ack=True
 except Exception:
  try: conn.sendall(b'{"error":"Process control failed"}\n')
  except Exception: pass
 finally:
  if acquired: lock.release()
  conn.close()
  ready.set()
server.settimeout(0.1)
slots=threading.BoundedSemaphore(8)
def bounded_handle(conn):
 try: handle(conn)
 finally: slots.release()
try:
 while True:
  with lock:
   if generation is not None and not parked and time.monotonic()-last_request>30:
    parked=True; discard=True; lease=None; queue.clear(); queued=0; lock.notify_all()
   # Poll/reap and signal stay under one lock: a reaped PID cannot race a signal.
   if final_ack or ((detached or parked) and (child is None or child.poll() is not None)): break
   # Lost setup handles cannot strand completed helpers indefinitely.
   if child is not None and child.poll() is not None and time.monotonic()-last_request>60: break
   # A failed setup must not leave a helper behind forever.
   if child is None and ready.is_set(): break
  try: conn,_=server.accept()
  except socket.timeout: continue
  if slots.acquire(blocking=False): threading.Thread(target=bounded_handle,args=(conn,),daemon=True).start()
  else: conn.close()
finally:
 server.close()
 if child is not None:
  for pipe in (child.stdin,child.stdout,child.stderr):
   if pipe is not None and not pipe.closed: pipe.close()
 if os.path.isfile(root+'/cancel'):
  try: os.unlink(root+'/control')
  except FileNotFoundError: pass
 else: shutil.rmtree(root)
`;

export const processRpc = String.raw`
import base64,json,os,socket,sys,time
cfg=json.loads(base64.b64decode(sys.argv[1]))
if cfg['request']['op']=='abandon':
 # Persistent private cancellation evidence blocks a launch delayed beyond HTTP cancellation.
 os.makedirs(cfg['root'],mode=0o700,exist_ok=True)
 try:
  with open(cfg['root']+'/cancel','x'): pass
 except FileExistsError: pass
 if not os.path.exists(cfg['root']+'/control'):
  print('{"ok":true}')
  sys.exit(0)
 cfg['request']=dict(cfg['request'],op='detach')
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(29)
deadline=time.monotonic()+min(cfg.get('wait',0),28)
while True:
 try:
  s.connect(cfg['root']+'/control')
  break
 except (FileNotFoundError,ConnectionRefusedError):
  if time.monotonic()>=deadline: raise
  time.sleep(0.02)
s.sendall(json.dumps(cfg['request'],separators=(',',':')).encode()+b'\n')
f=s.makefile('rb')
data=f.readline(100000)
if len(data)>=100000 or not data.endswith(b'\n'): raise ValueError('Process response exceeds bound')
sys.stdout.buffer.write(data)
s.close()
`;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

type ProcessOperation =
  | {
      op:
        | "status"
        | "read"
        | "close"
        | "terminate"
        | "discard"
        | "detach"
        | "abandon"
        | "disconnect";
    }
  | { op: "write"; data: string }
  | { op: "signal"; signal: "SIGTERM" | "SIGKILL" }
  | { op: "resize"; columns: number; rows: number }
  | { op: "hello"; nextLease: string };

export type ProcessRequest = ProcessOperation & { generation?: string; lease?: string };

type ProcessPayload =
  | {
      root: string;
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      pipe: boolean;
      generation?: string;
      lease?: string;
      terminal?: { columns: number; rows: number };
    }
  | { root: string; request: ProcessRequest; wait?: number };

export function pythonCommand(source: string, payload: ProcessPayload): string {
  const argument = Buffer.from(JSON.stringify(payload)).toString("base64");

  return `python3 -c ${quote(source)} ${quote(argument)}`;
}
