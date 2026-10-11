/* patch-closure.js — adds the "إغلاق الموقع" (close the clinic's public site)
 * card to the app bundle's إعدادات العيادة screen. Clinic staff use it to stop
 * the public booking site temporarily (with an optional notice + reopen date);
 * the dashboard keeps working. Talks to /api/clinics (GET + PUT). Idempotent. */
const fs = require("fs");
const path = require("path");
const B = path.join(__dirname, "..", "_next", "static", "chunks", "1fds2h4vn64um.js");

if (fs.readFileSync(B, "utf8").includes("function ui8SiteClosure")) {
  console.log("already patched, nothing to do");
  process.exit(0);
}

const CLOSURE = `function ui8SiteClosure(){
let{currentClinicId}=xM();
let[clinic,setClinic]=(0,d.useState)(null),[msg,setMsg]=(0,d.useState)(""),[until,setUntil]=(0,d.useState)(""),[busy,setBusy]=(0,d.useState)(!1),[note,setNote]=(0,d.useState)("");
let load=()=>{ if(!currentClinicId) return; fetch("/api/clinics?id="+currentClinicId).then(r=>r.ok?r.json():null).then(j=>{ if(j){ let c=j.clinic||j; setClinic(c); setMsg(c.siteClosedMessage||""); setUntil(c.siteClosedUntil||""); } }).catch(()=>{}); };
(0,d.useEffect)(()=>{load()},[currentClinicId]);
let apply=(closed)=>{ if(!clinic) return; setBusy(!0); setNote(""); fetch("/api/clinics",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:clinic.id,siteClosed:closed,siteClosedMessage:msg,siteClosedUntil:until})}).then(r=>r.json().then(j=>({ok:r.ok,j:j}))).then(o=>{ if(o.ok){ setClinic(o.j.clinic||o.j); setNote(closed?"تم إغلاق الموقع بنجاح.":"تم إعادة فتح الموقع."); } else setNote(o.j.error||"تعذّر تنفيذ العملية"); }).catch(()=>setNote("تعذّر تنفيذ العملية")).then(()=>setBusy(!1)); };
if(!clinic) return null;
let closed=!!clinic.siteClosed;
let badge=(0,u.jsx)("span",{className:"inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md "+(closed?"bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300":"bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"),children:closed?"مغلق":"مفتوح"});
let head=(0,u.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"0.75rem",marginBottom:"0.25rem"},children:[(0,u.jsx)("div",{className:"v3-icon-box",style:{background:"linear-gradient(135deg,#ef4444,#b91c1c)"},children:(0,u.jsx)(K.Shield,{size:20,className:"text-white"})}),(0,u.jsx)("h2",{className:"text-lg font-bold text-foreground",children:"إغلاق الموقع"}),badge]});
let desc=(0,u.jsx)("p",{className:"text-sm text-muted-foreground",children:"إيقاف استقبال الحجوزات عبر صفحة الحجز العامة مؤقتاً (إجازة، اكتمال المواعيد، صيانة). لوحة التحكم تبقى تعمل بشكل طبيعي."});
let msgField=(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"v3-label",children:"رسالة للمرضى (اختياري)"}),(0,u.jsx)("textarea",{className:"v3-input",style:{resize:"none"},rows:3,value:msg,onChange:e=>setMsg(e.target.value),placeholder:"مثال: العيادة في إجازة، سنعود قريباً."})]});
let untilField=(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"v3-label",children:"تاريخ العودة المتوقع (اختياري)"}),(0,u.jsx)("input",{type:"date",className:"v3-input",value:until,onChange:e=>setUntil(e.target.value)})]});
let noteEl=note?(0,u.jsx)("span",{className:"text-sm text-orange-600 dark:text-orange-400",children:note}):null;
let btn=(0,u.jsxs)("div",{className:"flex items-center gap-3 pt-2",children:[closed?(0,u.jsxs)("button",{onClick:()=>apply(!1),disabled:busy,className:"flex items-center gap-2 px-6 py-2.5 bg-gradient-to-l from-emerald-500 to-emerald-700 text-white rounded-xl font-medium disabled:opacity-50",children:[(0,u.jsx)(H,{size:16}),busy?"جارٍ...":"إعادة فتح الموقع"]}):(0,u.jsxs)("button",{onClick:()=>apply(!0),disabled:busy,className:"flex items-center gap-2 px-6 py-2.5 bg-gradient-to-l from-rose-500 to-rose-700 text-white rounded-xl font-medium disabled:opacity-50",children:[(0,u.jsx)(H,{size:16}),busy?"جارٍ...":"إغلاق الموقع"]}),noteEl]});
return(0,u.jsxs)("div",{className:"v3-card space-y-4",children:[head,desc,msgField,untilField,btn]});
}
`;

let c = fs.readFileSync(B, "utf8");
function spliceOnce(anchor, insert, label) {
  const n = c.split(anchor).length - 1;
  if (n !== 1) throw new Error(label + ": expected 1 anchor, got " + n);
  const i = c.indexOf(anchor);
  c = c.slice(0, i) + insert + c.slice(i + anchor.length);
  console.log("  ok  " + label);
}
spliceOnce("function xG(){", CLOSURE + "function xG(){", "inject ui8SiteClosure");
spliceOnce(']})]}),t?.role==="super_admin"&&', ']})]}),(0,u.jsx)(ui8SiteClosure,{}),t?.role==="super_admin"&&', "render closure card on الإعدادات");
fs.writeFileSync(B, c, "utf8");
console.log("bundle written: " + c.length + " bytes");
