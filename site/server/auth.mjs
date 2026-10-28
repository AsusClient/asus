import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const USERS_STORE = join(HERE, "users.json");

const b64u = (v)=>Buffer.from(v).toString("base64url");

export function signToken(p,s){
  const b=b64u(JSON.stringify(p));
  const m=createHmac("sha256",s).update(b).digest("base64url");
  return b+"."+m;
}

export function verifyToken(t,s){
  if(!t||t.indexOf(".")<0)return null;
  const parts=t.split(".");
  if(parts.length!==2)return null;
  const b=parts[0],m=parts[1];
  if(!b||!m)return null;
  const e=createHmac("sha256",s).update(b).digest();
  let g;
  try{g=Buffer.from(m,"base64url");}catch{return null;}
  if(g.length!==e.length||!timingSafeEqual(g,e))return null;
  try{
    const d=JSON.parse(Buffer.from(b,"base64url").toString("utf8"));
    if(!d||typeof d.exp!=="number"||d.exp<Date.now())return null;
    return d;
  }catch{return null;}
}

export async function loadUsers(f=USERS_STORE){
  try{
    const r=await readFile(f,"utf8");
    const p=JSON.parse(r);
    if(!p||typeof p!=="object"||!p.users)throw new Error("bad");
    return p;
  }catch(err){
    if(err.code==="ENOENT")return{version:1,users:{}};
    throw err;
  }
}

let cache=null;
let wq=Promise.resolve();
async function persist(st,f=USERS_STORE){
  wq=wq.then(async()=>{
    await mkdir(dirname(f),{recursive:true});
    const tmp=f+"."+randomBytes(4).toString("hex")+".tmp";
    await writeFile(tmp,JSON.stringify(st,null,2)+"\n","utf8");
    await rename(tmp,f);
  });
  return wq;
}

export async function getStore(){
  if(!cache)cache=await loadUsers();
  return cache;
}

export async function findUserByEmail(email){
  const st=await getStore();
  const e=(email||"").toLowerCase().trim();
  for(const u of Object.values(st.users)){
    if((u.email||"").toLowerCase()===e)return{store:st,user:u};
  }
  return{store:st,user:null};
}

export async function createUser({email,password,name}){
  const st=await getStore();
  const id=randomBytes(16).toString("hex");
  const salt=randomBytes(16).toString("hex");
  const ph=createHmac("sha256",salt).update(password||"").digest("hex");
  const u={id,email:(email||"").toLowerCase().trim(),name:(name||email||"").trim(),salt,passHash:ph,provider:"email",createdAt:Date.now(),key:null,premium:false};
  st.users[id]=u;
  await persist(st);
  return u;
}

export async function verifyPassword(u,p){
  if(!u)return false;
  const ph=createHmac("sha256",u.salt||"").update(p||"").digest("hex");
  return ph===u.passHash;
}

export async function setUserKey(id,k){
  const st=await getStore();
  const u=st.users[id];
  if(!u)return null;
  u.key=k;
  u.premium=true;
  await persist(st);
  return u;
}

export async function getUserById(id){
  const st=await getStore();
  return st.users[id]||null;
}
