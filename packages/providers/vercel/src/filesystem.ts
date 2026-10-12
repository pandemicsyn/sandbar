import { z } from "zod";
import {
  AdapterError,
  AdapterFilesystemError,
  type FileStat,
  type Json,
} from "@sandbar-sdk/adapter";

// Managed Node image helper. Arguments are JSON data; replies never contain file contents.
export const filesystemHelper = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { op, path: p, destination: q, flag, stage } = JSON.parse(process.argv[1]);
let applied = false, uncertain = false, stageOwned = false;
const kind = s => s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'unknown';
const regular = p => { if (!fs.lstatSync(p).isFile()) throw Object.assign(new Error(), {code:'EINVAL'}); };
const publish = (a,b) => {
  try { regular(b); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  if(flag) { fs.renameSync(a,b); applied=true; }
  else { fs.linkSync(a,b); applied=true; fs.unlinkSync(a); }
};
try {
 let value = {};
 if(op === 'list') {
   const entries=[]; let names=0;
   const dir=fs.opendirSync(p,{encoding:"buffer"});
   try { for(let e; (e=dir.readSync());) {
     names += e.name.length;
     if(entries.length >= 1024 || names > 65536) throw Object.assign(new Error(), {code:'EFBIG'});
     entries.push({name:new TextDecoder("utf-8",{fatal:true}).decode(e.name),type:kind(e)});
   }} finally { dir.closeSync(); }
   entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
   value={entries,completeness:'complete'};
 } else if(op === 'stat') {
   const s=flag ? fs.statSync(p) : fs.lstatSync(p);
   value={type:kind(s),sizeBytes:s.size,modifiedAt:s.mtime.toISOString(),mode:s.mode & 0o7777};
 } else if(op === 'mkdir') {
   try { uncertain=flag; fs.mkdirSync(p,{recursive:flag}); uncertain=false; }
   catch(e) { if(e.code !== 'EEXIST' || !fs.statSync(p).isDirectory()) throw e; }
 } else if(op === 'remove') {
   try { const s=fs.lstatSync(p);
     if(s.isDirectory()) { if(flag) { uncertain=true; fs.rmSync(p,{recursive:true}); uncertain=false; } else fs.rmdirSync(p); }
     else fs.unlinkSync(p);
   } catch(e) { if(e.code !== 'ENOENT') throw e; }
 } else if(op === 'reserve') {
   fs.closeSync(fs.openSync(p,'wx',0o600));
 } else if(op === 'publish') {
   regular(p); publish(p,q);
 } else if(op === 'append') {
   regular(p); regular(q);
   const src=fs.openSync(q,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
   const dst=fs.openSync(p,fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
   try { const b=Buffer.alloc(65536); for(let n;(n=fs.readSync(src,b));) {
     let offset=0; while(offset<n) offset+=fs.writeSync(dst,b,offset,n-offset);
   }} finally { fs.closeSync(src); fs.closeSync(dst); }
   fs.unlinkSync(q);
 } else if(op === 'copy') {
   regular(p);
   const src=fs.openSync(p,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
   let dst;
   try {
     if(!fs.fstatSync(src).isFile()) throw Object.assign(new Error(), {code:'EINVAL'});
     dst=fs.openSync(stage,'wx',0o600); stageOwned=true;
     const b=Buffer.alloc(65536);
     for(let n;(n=fs.readSync(src,b));) { let offset=0; while(offset<n) offset+=fs.writeSync(dst,b,offset,n-offset); }
     fs.closeSync(dst);dst=undefined;
     publish(stage,q); stageOwned=false;
   } finally { fs.closeSync(src); if(dst!==undefined) fs.closeSync(dst); }
 } else if(op === 'move') {
   if(flag) { fs.renameSync(p,q); applied=true; }
   else {
     const script="import ctypes,os,sys,json\nlib=ctypes.CDLL(None,use_errno=True)\nfn=getattr(lib,'renameat2',None)\nif fn is None: print(json.dumps({'errno':38}))\nelse:\n r=fn(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)\n print(json.dumps({'errno':ctypes.get_errno() if r else 0}))";
     const child=spawnSync('python3',['-c',script,p,q],{encoding:'utf8',timeout:30000,maxBuffer:4096});
     if(child.error?.code==='ENOENT') throw Object.assign(new Error(),{code:'ENOSYS'});
     if(child.error || child.status!==0) {uncertain=true;throw Object.assign(new Error(),{code:'EIO'});}
     const n=JSON.parse(child.stdout).errno;
     if(n) throw Object.assign(new Error(),{code:({2:'ENOENT',17:'EEXIST',18:'EXDEV',38:'ENOSYS',13:'EACCES',39:'ENOTEMPTY'})[n] || 'EINVAL'});
     applied=true;
   }
 } else throw Object.assign(new Error(), {code:'ENOSYS'});
 console.log(JSON.stringify({ok:true,value}));
} catch(e) {
 if(op === 'copy' && stageOwned && !applied && !uncertain) { try { fs.unlinkSync(stage); stageOwned=false; } catch {} }
 const code = e.code === 'ENOENT' ? 'NOT_FOUND' : ['EEXIST','ENOTEMPTY'].includes(e.code) ? 'CONFLICT' : ['EACCES','EPERM'].includes(e.code) ? 'FORBIDDEN' : ['EFBIG','ENOSPC'].includes(e.code) ? 'CAPACITY' : ['EXDEV','ENOSYS','ENOTSUP'].includes(e.code) ? 'UNSUPPORTED' : 'INVALID_ARGUMENT';
 console.log(JSON.stringify({ok:false,code,effect:applied ? 'applied' : uncertain ? 'possible' : 'none',temporaryPaths:stageOwned ? [stage] : []}));
}
`;

const reply = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.json() }),
  z.strictObject({
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
    temporaryPaths: z.array(z.string()).optional(),
  }),
]);

export function filesystemValue(bytes: Uint8Array): Json {
  const result = reply.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));

  if (!result.ok)
    throw new AdapterFilesystemError(result.code, "Vercel filesystem helper rejected request", {
      effect: result.effect,
      temporaryPaths: result.temporaryPaths,
    });

  return result.value;
}

export const directorySchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        name: z.string(),
        type: z.enum(["file", "directory", "symlink", "unknown"]),
      }),
    )
    .max(1024),
  completeness: z.literal("complete"),
});

export function fileStat(value: Json): FileStat {
  const parsed = z
    .strictObject({
      type: z.enum(["file", "directory", "symlink", "unknown"]),
      sizeBytes: z.number().int().nonnegative().safe(),
      modifiedAt: z.iso.datetime(),
      mode: z.number().int().nonnegative(),
    })
    .safeParse(value);

  if (!parsed.success) throw new AdapterError("UNAVAILABLE", "Invalid filesystem stat receipt");

  return parsed.data;
}
