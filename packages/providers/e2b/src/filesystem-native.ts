import type { Sandbox } from "e2b";
import {
  AdapterError,
  AdapterFilesystemError,
  type DirectoryResult,
  type FileStat,
} from "sandbar-adapter";
import { z } from "zod";

// Python3 is supplied by the supported E2B base image. Paths are arguments, never program text.
export const FILESYSTEM_HELPER = String.raw`
import os,sys,json,stat,errno,ctypes,tempfile,shutil
op,p,q,flag,stage=sys.argv[1:6]
published=False
created=False
overwrite=flag=='true'
def kind(s):
 return 'symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'unknown'
def rename(a,b):
 if overwrite: os.replace(a,b)
 else:
  libc=ctypes.CDLL(None,use_errno=True)
  fn=getattr(libc,'renameat2',None)
  if fn is None: raise OSError(errno.ENOSYS,'renameat2 unavailable')
  if fn(-100,os.fsencode(a),-100,os.fsencode(b),1)!=0:
   e=ctypes.get_errno();raise OSError(e,os.strerror(e))
def publish(a,b):
 global published
 if os.path.lexists(b) and not stat.S_ISREG(os.lstat(b).st_mode): raise OSError(errno.EINVAL,'regular destination required')
 if overwrite: os.replace(a,b);published=True
 else:
  os.link(a,b,follow_symlinks=False);published=True;os.unlink(a)
def regular(path):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode): raise OSError(errno.EINVAL,'regular file required')
try:
 result={}
 if op=='list':
  entries=[]; names=0
  with os.scandir(p) as it:
   for e in it:
    names+=len(e.name.encode('utf-8'))
    if len(entries)>=1024 or names>65536: raise OSError(errno.EFBIG,'directory bound exceeded')
    try: t=kind(e.stat(follow_symlinks=False))
    except FileNotFoundError: t='unknown'
    entries.append({'name':e.name,'type':t})
  entries.sort(key=lambda e:e['name'])
  result={'entries':entries,'completeness':'complete'}
 elif op=='stat':
  s=os.stat(p) if overwrite else os.lstat(p)
  result={'type':kind(s),'sizeBytes':s.st_size,'modifiedAt':s.st_mtime,'mode':stat.S_IMODE(s.st_mode)}
 elif op=='mkdir':
  try:
   if overwrite: os.makedirs(p,exist_ok=True)
   else: os.mkdir(p)
  except FileExistsError:
   if not os.path.isdir(p): raise
 elif op=='remove':
  try:
   s=os.lstat(p)
   if stat.S_ISDIR(s.st_mode):
    if overwrite: shutil.rmtree(p)
    else: os.rmdir(p)
   else: os.unlink(p)
  except FileNotFoundError: pass
 elif op=='reserve':
  fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 elif op=='publish':
  regular(p);publish(p,q);published=True
 elif op=='copy':
  regular(p)
  if os.path.lexists(q) and not stat.S_ISREG(os.lstat(q).st_mode): raise OSError(errno.EINVAL,'regular destination required')
  fd=os.open(stage,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);created=True
  try:
   src=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
   with os.fdopen(src,'rb') as inp,os.fdopen(fd,'wb') as out:
    if not stat.S_ISREG(os.fstat(inp.fileno()).st_mode): raise OSError(errno.EINVAL,'regular file required')
    shutil.copyfileobj(inp,out,65536)
   publish(stage,q);published=True
  finally:
   if created and os.path.lexists(stage): os.unlink(stage)
 elif op=='move':
  os.lstat(p);rename(p,q)
 print(json.dumps({'ok':True,'value':result},ensure_ascii=True))
except OSError as e:
 code='NOT_FOUND' if e.errno==errno.ENOENT else 'CONFLICT' if e.errno in (errno.EEXIST,errno.ENOTEMPTY) else 'FORBIDDEN' if e.errno in (errno.EACCES,errno.EPERM) else 'CAPACITY' if e.errno in (errno.EFBIG,errno.ENOSPC) else 'UNSUPPORTED' if e.errno in (errno.EXDEV,errno.ENOSYS,errno.EOPNOTSUPP) else 'INVALID_ARGUMENT'
 print(json.dumps({'ok':False,'code':code,'effect':'applied' if published else 'possible' if created and os.path.lexists(stage) else 'none','temporaryPaths':[stage] if created and os.path.lexists(stage) else []}))
`;

const Result = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "NOT_FOUND",
      "CONFLICT",
      "FORBIDDEN",
      "CAPACITY",
      "UNSUPPORTED",
      "INVALID_ARGUMENT",
    ]),
    effect: z.enum(["none", "possible", "applied"]),
    temporaryPaths: z.array(z.string()),
  }),
]);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function guestFilesystem(
  sandbox: Sandbox,
  op: string,
  path: string,
  destination = "",
  flag = false,
  signal?: AbortSignal,
  stage = "",
) {
  signal?.throwIfAborted();

  const command = ["python3", "-c", FILESYSTEM_HELPER, op, path, destination, String(flag), stage]
    .map(quote)
    .join(" ");

  const result = await sandbox.commands.run(command, {
    timeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    signal,
    stdin: false,
  });

  const invalidResponse = () =>
    op === "list" || op === "stat"
      ? new AdapterError("UNAVAILABLE", "E2B filesystem helper response is invalid")
      : new AdapterFilesystemError(
          "UNAVAILABLE",
          "E2B filesystem helper acknowledgement is invalid",
          {
            effect: "possible",
            source: path,
            destination: destination || path,
            temporaryPaths: stage ? [stage] : [],
          },
        );

  if (result.exitCode !== 0 || result.stdout.length > 524_288) throw invalidResponse();
  let response: z.infer<typeof Result>;

  try {
    response = Result.parse(JSON.parse(result.stdout));
  } catch {
    throw invalidResponse();
  }

  if (!response.ok)
    throw new AdapterFilesystemError(response.code, "E2B filesystem request rejected", {
      effect: response.effect,
      source: path,
      destination: destination || path,
      temporaryPaths: response.temporaryPaths,
    });

  return response.value;
}

export const Directory = z.object({
  entries: z.array(
    z.object({ name: z.string(), type: z.enum(["file", "directory", "symlink", "unknown"]) }),
  ),
  completeness: z.literal("complete"),
});

export function directoryValue(value: z.infer<ReturnType<typeof z.json>>): DirectoryResult {
  const parsed = Directory.safeParse(value);

  if (!parsed.success) throw new AdapterError("UNAVAILABLE", "E2B directory response is invalid");

  return { ...parsed.data, observedAt: new Date().toISOString() };
}

export function statValue(value: z.infer<ReturnType<typeof z.json>>): FileStat {
  const result = z
    .object({
      type: z.enum(["file", "directory", "symlink", "unknown"]),
      sizeBytes: z.number().int().nonnegative().safe(),
      modifiedAt: z.number(),
      mode: z.number().int().nonnegative(),
    })
    .safeParse(value);

  if (!result.success || Math.abs(result.data.modifiedAt * 1000) > 8_640_000_000_000_000)
    throw new AdapterError("UNAVAILABLE", "E2B metadata response is invalid");

  return { ...result.data, modifiedAt: new Date(result.data.modifiedAt * 1000).toISOString() };
}
