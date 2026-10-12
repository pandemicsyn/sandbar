import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  AdapterError,
  AdapterFilesystemError,
  type ReadContext,
  type FileTransferContext,
  type DirectoryResult,
  type FileStat,
} from "@sandbar-sdk/adapter";
import { z } from "zod";
import { type BoxdNativeClient, type CallContext } from "./transport";

// Adapter-owned finite helper. Python 3 is an image prerequisite, never installed automatically.
export const FILESYSTEM_HELPER = String.raw`
import os,sys,json,stat,errno,ctypes,tempfile,shutil,base64
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
 if overwrite and os.path.lexists(b) and not stat.S_ISREG(os.lstat(b).st_mode): raise OSError(errno.EINVAL,'regular destination required')
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
   if not os.path.isdir(p): raise OSError(errno.EINVAL,'existing entry is not a directory')
 elif op=='remove':
  try:
   s=os.lstat(p)
   if stat.S_ISDIR(s.st_mode):
    if overwrite: shutil.rmtree(p)
    else: os.rmdir(p)
   else: os.unlink(p)
  except FileNotFoundError: pass
 elif op=='write':
  data=sys.stdin.buffer.read(1048577)
  if len(data)>1048576: raise OSError(errno.EFBIG,'buffer bound exceeded')
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);published=True
  with os.fdopen(fd,'wb') as f: f.write(data)
  result={'bytesWritten':len(data)}
 elif op=='exists':
  try: os.lstat(p);result={'exists':True}
  except FileNotFoundError: result={'exists':False}
 elif op=='read':
  fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as f:
   if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise OSError(errno.EINVAL,'regular file required')
   f.seek(int(q));data=f.read(65536)
  result={'data':base64.b64encode(data).decode('ascii'),'eof':len(data)<65536}
 elif op=='append':
  fd=os.open(p,os.O_WRONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'r+b') as f:
   f.seek(0,2)
   if f.tell()!=int(q): raise OSError(errno.EINVAL,'unexpected staging size')
   data=base64.b64decode(stage,validate=True)
   if len(data)>65536: raise OSError(errno.EFBIG,'chunk bound exceeded')
   f.write(data)
  result={'bytesWritten':len(data)}
 elif op=='reserve':
  fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 elif op=='publish':
  regular(p);publish(p,q);published=True
 elif op=='copy':
  regular(p)
  if overwrite and os.path.lexists(q) and not stat.S_ISREG(os.lstat(q).st_mode): raise OSError(errno.EINVAL,'regular destination required')
  fd=os.open(stage,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);created=True
  try:
   src=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
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
 print(json.dumps({'ok':False,'code':code,'effect':'applied' if published else 'possible' if (created and os.path.lexists(stage)) or (op in ('mkdir','remove') and overwrite) else 'none','temporaryPaths':[stage] if created and os.path.lexists(stage) else []}))
`;

const Receipt = z.discriminatedUnion("ok", [
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

export function filesystem(native: BoxdNativeClient, id: string) {
  const run = async (
    op: string,
    path: string,
    destination = "",
    flag = false,
    ctx: ReadContext,
    stage = "",
    stdin?: Uint8Array,
  ) => {
    ctx.signal.throwIfAborted();

    const call: CallContext = {
      ...ctx,
      deadline: Math.min(ctx.deadline, Date.now() + 30000),
      maxBytes: 524288,
      confirmedExit: undefined,
      truncated: false,
      stdin,
      cancelOnAbort: true,
    };

    const mutation = !["stat", "list", "exists", "read"].includes(op);

    const uncertain = () =>
      new AdapterFilesystemError(
        "UNAVAILABLE",
        "boxd filesystem response was not confirmed; do not replay",
        {
          effect: "possible",
          source: path,
          destination: destination || path,
          temporaryPaths: stage && op !== "append" ? [stage] : [],
        },
      );

    let receipt: z.infer<typeof Receipt>;

    try {
      const result = await native.run(call, () =>
        native.machines.exec(id, {
          command: ["python3", "-c", FILESYSTEM_HELPER, op, path, destination, String(flag), stage],
          encoding: "buffer",
        }),
      );

      if (call.confirmedExit !== 0 || call.truncated)
        throw new AdapterError(
          "UNAVAILABLE",
          "boxd filesystem helper failed; Python 3 is required",
        );
      receipt = Receipt.parse(JSON.parse(new TextDecoder().decode(result.stdout)));
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;

      if (mutation) throw uncertain();
      throw error;
    }

    if (!receipt.ok)
      throw new AdapterFilesystemError(receipt.code, "boxd filesystem request rejected", {
        effect: receipt.effect,
        source: path,
        destination: destination || path,
        temporaryPaths: receipt.temporaryPaths,
      });

    return receipt.value;
  };

  const staging = (path: string) => posix.join(posix.dirname(path), `.sandbar-${randomUUID()}`);

  const write = async (
    path: string,
    bytes: AsyncIterable<Uint8Array>,
    overwrite: boolean,
    ctx: FileTransferContext,
  ) => {
    const stage = staging(path);
    let count = 0;
    ctx.retain?.({ temporaryPaths: [stage] });

    try {
      await run("reserve", stage, "", false, ctx);

      // Keep the correlated stage on uncertain input/transport failure. No automatic replay.
      for await (const input of bytes) {
        for (let offset = 0; offset < input.length; offset += 65536) {
          ctx.signal.throwIfAborted();
          const chunk = input.subarray(offset, offset + 65536);
          const chunkContext = { ...ctx, deadline: Date.now() + 30000 };

          const ack = z
            .object({ bytesWritten: z.number().int() })
            .parse(
              await run(
                "append",
                stage,
                String(count),
                false,
                chunkContext,
                Buffer.from(chunk).toString("base64"),
              ),
            );

          if (ack.bytesWritten !== chunk.length)
            throw new AdapterFilesystemError("UNAVAILABLE", "boxd staging byte count differs", {
              effect: "possible",
              source: stage,
              destination: path,
              temporaryPaths: [stage],
            });
          count += chunk.length;
          ctx.retain?.({ temporaryPaths: [stage], bytesTransferred: count });
        }
      }

      await run("publish", stage, path, overwrite, { ...ctx, deadline: Date.now() + 30000 });
      ctx.retain?.({ effect: "applied", temporaryPaths: [], bytesTransferred: count });

      return { bytesWritten: count };
    } catch (error) {
      if (error instanceof AdapterFilesystemError) {
        if (error.details.effect === "applied")
          ctx.retain?.({ effect: "applied", temporaryPaths: [stage], bytesTransferred: count });
        throw new AdapterFilesystemError(error.code, error.message, {
          ...error.details,
          source: stage,
          destination: path,
          temporaryPaths: [stage],
          bytesTransferred: count,
        });
      }

      throw error;
    }
  };

  return {
    run,
    write,
    async transfer(
      op: "copy" | "move",
      source: string,
      destination: string,
      overwrite: boolean,
      ctx: FileTransferContext,
    ) {
      const stage = op === "copy" ? staging(destination) : "";
      ctx.retain?.({ temporaryPaths: stage ? [stage] : [] });
      await run(op, source, destination, overwrite, ctx, stage);
      ctx.retain?.({ effect: "applied", temporaryPaths: [] });

      return { acknowledged: true as const };
    },
    read(path: string, ctx: ReadContext) {
      let offset = 0;
      const cancellation = new AbortController();
      ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, cancellation.signal]) };

      return new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancellation.abort();
          },
          async pull(controller) {
            try {
              const chunk = z.object({ data: z.string().max(87384), eof: z.boolean() }).parse(
                await run("read", path, String(offset), false, {
                  ...ctx,
                  deadline: Date.now() + 30000,
                }),
              );

              const bytes = Buffer.from(chunk.data, "base64");

              if (
                bytes.length > 65536 ||
                bytes.toString("base64") !== chunk.data ||
                (!chunk.eof && bytes.length !== 65536)
              )
                throw new AdapterError("UNAVAILABLE", "boxd file chunk is malformed");
              offset += bytes.length;

              if (bytes.length) controller.enqueue(bytes);

              if (chunk.eof) controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}

export const Directory = z.object({
  entries: z.array(
    z.object({ name: z.string(), type: z.enum(["file", "directory", "symlink", "unknown"]) }),
  ),
  completeness: z.literal("complete"),
});

export function directoryValue(value: z.infer<ReturnType<typeof z.json>>): DirectoryResult {
  const parsed = Directory.safeParse(value);

  if (!parsed.success) throw new AdapterError("UNAVAILABLE", "boxd directory response is invalid");

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
    throw new AdapterError("UNAVAILABLE", "boxd metadata response is invalid");

  return { ...result.data, modifiedAt: new Date(result.data.modifiedAt * 1000).toISOString() };
}
