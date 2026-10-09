import { z } from "zod";
import { AdapterError, AdapterFilesystemError, type FileEntry } from "sandbar-adapter";

// Paths travel as one base64 JSON argument, never as shell program text.
export const FILESYSTEM_HELPER = String.raw`
import os,sys,json,stat,errno,shutil,ctypes,datetime,tempfile
x=json.loads(__import__('base64').b64decode(sys.argv[1]))
applied=False
possible=False
stage_directory=None
def kind(s):
 return 'symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'unknown'
def rename(a,b,overwrite):
 if overwrite: os.rename(a,b); return
 libc=ctypes.CDLL(None,use_errno=True)
 fn=getattr(libc,'renameat2',None)
 if fn is None: raise OSError(errno.ENOSYS,'renameat2 unavailable')
 fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 if fn(-100,os.fsencode(a),-100,os.fsencode(b),1)!=0:
  e=ctypes.get_errno(); raise OSError(e,os.strerror(e))
def run():
 global applied,possible,stage_directory
 op=x['op']; p=x.get('path')
 if op=='list':
  out=[]; names=0
  with os.scandir(p) as entries:
   for e in entries:
    names+=len(e.name.encode('utf-8'))
    if len(out)>=1024 or names>65536: raise OSError(errno.EFBIG,'directory capacity')
    try: t=kind(e.stat(follow_symlinks=False))
    except FileNotFoundError: t='unknown'
    out.append({'name':e.name,'type':t})
  return sorted(out,key=lambda e:e['name'])
 if op=='stat':
  s=os.stat(p,follow_symlinks=x.get('follow',False))
  return {'type':kind(s),'sizeBytes':s.st_size,'mode':stat.S_IMODE(s.st_mode),'modifiedAt':datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat()}
 if op=='exists':
  try: os.lstat(p); return True
  except FileNotFoundError: return False
 if op=='mkdir':
  if os.path.lexists(p) and not os.path.isdir(p): raise OSError(errno.EINVAL,'existing non-directory')
  if x['recursive']:
   possible=True
   try: os.makedirs(p,exist_ok=True)
   except FileExistsError: raise OSError(errno.EINVAL,'existing entry is not a directory')
  else:
   try: os.mkdir(p)
   except FileExistsError:
    if not os.path.isdir(p): raise OSError(errno.EINVAL,'existing entry is not a directory')
  return True
 if op=='remove':
  try: s=os.lstat(p)
  except FileNotFoundError: return True
  if stat.S_ISDIR(s.st_mode):
   if x['recursive']:
    possible=True; shutil.rmtree(p)
   else: os.rmdir(p)
  else: os.unlink(p)
  return True
 if op=='reserve': os.mkdir(p,0o700); return p
 if op=='cleanup':
  try: os.unlink(p+'/payload')
  except FileNotFoundError: pass
  os.rmdir(p); return True
 if op=='publish':
  if os.path.lexists(x['destination']) and not stat.S_ISREG(os.lstat(x['destination']).st_mode): raise OSError(errno.EINVAL,'regular destination required')
  rename(p,x['destination'],x['overwrite']); return True
 if op in ('copy','move'):
  a=x['source']; b=x['destination']
  if a==b: raise OSError(errno.EINVAL,'same path')
  if op=='move': rename(a,b,x['overwrite']); return True
  if not stat.S_ISREG(os.lstat(a).st_mode): raise OSError(errno.EINVAL,'regular source required')
  if os.path.lexists(b) and not stat.S_ISREG(os.lstat(b).st_mode): raise OSError(errno.EINVAL,'regular destination required')
  d=x['stagingDirectory']; os.mkdir(d,0o700); stage=d+'/payload'; stage_directory=d
  try:
   fd=os.open(a,os.O_RDONLY|os.O_NOFOLLOW)
   with os.fdopen(fd,'rb') as source, open(stage,'xb') as dest:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise OSError(errno.EINVAL,'regular source required')
    shutil.copyfileobj(source,dest,65536)
   rename(stage,b,x['overwrite']); applied=True
  finally:
   if os.path.lexists(stage): os.unlink(stage)
   os.rmdir(d)
  return True
 raise OSError(errno.EINVAL,'unknown operation')
try: print(json.dumps({'ok':True,'value':run()},ensure_ascii=True))
except OSError as e: print(json.dumps({'ok':False,'errno':e.errno,'errorName':errno.errorcode.get(e.errno,'EUNKNOWN'),'applied':applied,'possible':possible,'temporaryPaths':[stage_directory] if stage_directory and os.path.lexists(stage_directory) else []}))
`;

export function filesystemCommand(input: FilesystemInput): string {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

  return `python3 -c ${quote(FILESYSTEM_HELPER)} ${quote(Buffer.from(JSON.stringify(input)).toString("base64"))}`;
}

export type FilesystemInput = {
  op: string;
  path?: string;
  source?: string;
  destination?: string;
  stagingDirectory?: string;
  follow?: boolean;
  recursive?: boolean;
  overwrite?: boolean;
};

const Entry = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "symlink", "unknown"]),
});

export const GuestStat = z.object({
  type: Entry.shape.type,
  sizeBytes: z.number().int().nonnegative().safe(),
  mode: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime({ offset: true }),
});

const GuestValue = z.union([z.boolean(), z.string(), z.array(Entry), GuestStat]);

export type FilesystemValue = z.infer<typeof GuestValue>;

const GuestResult = z.object({
  ok: z.boolean(),
  value: GuestValue.optional(),
  errno: z.number().optional(),
  errorName: z.string().optional(),
  applied: z.boolean().optional(),
  possible: z.boolean().optional(),
  temporaryPaths: z.array(z.string()).optional(),
});

export function filesystemResult(text: string, input?: FilesystemInput): FilesystemValue {
  const result = GuestResult.parse(JSON.parse(text));

  if (result.ok === true && result.value !== undefined) return result.value;

  const code =
    result.errno === 2
      ? "NOT_FOUND"
      : result.errno === 13 || result.errno === 1
        ? "FORBIDDEN"
        : ["EEXIST", "ENOTEMPTY"].includes(result.errorName ?? "") ||
            result.errno === 17 ||
            result.errno === 39
          ? "CONFLICT"
          : result.errno === 27 || result.errno === 28
            ? "CAPACITY"
            : ["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(result.errorName ?? "") ||
                result.errno === 18 ||
                result.errno === 38 ||
                result.errno === 95
              ? "UNSUPPORTED"
              : "INVALID_ARGUMENT";

  if (result.applied || result.possible || result.temporaryPaths?.length)
    throw new AdapterFilesystemError(code, "Daytona filesystem effects incomplete", {
      effect: result.applied ? "applied" : result.possible ? "possible" : "none",
      source: input?.source,
      destination: input?.destination,
      temporaryPaths: result.temporaryPaths,
    });
  throw new AdapterError(code, `Daytona filesystem operation rejected (errno ${result.errno})`);
}

export function directoryEntries(value: FilesystemValue): FileEntry[] {
  if (!Array.isArray(value)) throw new AdapterError("UNAVAILABLE", "Invalid directory response");

  return z.array(Entry).parse(value);
}
