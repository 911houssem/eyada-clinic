/* patch-2fa.js — adds the two-factor (TOTP) card to the app bundle's الأمان
 * screen. The card talks to the new /api/auth/2fa endpoints: it renders the
 * server-produced SVG QR of the otpauth:// URL, then confirms a 6-digit code.
 * Idempotent: refuses to run twice. */
const fs = require("fs");
const path = require("path");
const B = path.join(__dirname, "..", "_next", "static", "chunks", "1fds2h4vn64um.js");

if (fs.readFileSync(B, "utf8").includes("function ui8TwoFactor")) {
  console.log("already patched, nothing to do");
  process.exit(0);
}

const TWO_FA = `function ui8TwoFactor(){
let[on,setOn]=(0,d.useState)(null),[secret,setSecret]=(0,d.useState)(""),[qr,setQr]=(0,d.useState)(""),[code,setCode]=(0,d.useState)(""),[del,setDel]=(0,d.useState)(""),[busy,setBusy]=(0,d.useState)(!1),[msg,setMsg]=(0,d.useState)("");
let load=()=>{fetch("/api/auth/2fa").then(r=>r.ok?r.json():null).then(j=>setOn(!!(j&&j.enabled))).catch(()=>setOn(!1))};
(0,d.useEffect)(()=>{load()},[]);
let req=(p,b)=>{setBusy(!0);setMsg("");return fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(r=>r.json().catch(()=>({})).then(j=>({r:r,j:j}))).catch(()=>({r:{ok:!1},j:{}})).then(o=>{setBusy(!1);return o})};
let setup=()=>req("/api/auth/2fa/setup",{}).then(o=>{if(o.r.ok){setSecret(o.j.secret||"");setQr(o.j.qr||"");setMsg("امسح رمز QR بتطبيق المصادقة ثم اكتب الرمز المكوّن من ٦ أرقام.")}else setMsg(o.j.error||"تعذّر بدء الإعداد")});
let enable=()=>{if(!code.trim())return void setMsg("أدخل الرمز المكوّن من ٦ أرقام.");return req("/api/auth/2fa/enable",{code:code.trim()}).then(o=>{if(o.r.ok){setOn(!0);setSecret("");setQr("");setCode("");setMsg("تم تمكين التحقق الثنائي بنجاح.")}else setMsg(o.j.error||"رمز غير صحيح")})};
let disable=()=>{if(!del.trim())return void setMsg("أدخل الرمز الحالي لتعطيل الحماية.");return req("/api/auth/2fa/disable",{code:del.trim()}).then(o=>{if(o.r.ok){setOn(!1);setDel("");setMsg("تم تعطيل التحقق الثنائي.")}else setMsg(o.j.error||"رمز غير صحيح")})};
let badge=(0,u.jsx)("span",{className:"inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md "+(on?"bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300":"bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"),children:on?"ممكّن":"غير ممكّن"});
let head=(0,u.jsxs)("div",{className:"flex items-center justify-between gap-3",children:[(0,u.jsx)("h2",{className:"font-semibold",children:"التحقق الثنائي (2FA)"}),badge]});
let desc=(0,u.jsx)("p",{className:"text-xs text-slate-500",children:"حماية إضافية: يُطلب رمز من تطبيق المصادقة عند تسجيل الدخول."});
let msgEl=msg?(0,u.jsx)("p",{className:"text-sm "+(msg.indexOf("تم")===0?"text-emerald-500":"text-amber-500"),children:msg}):null;
let qrBox=qr?(0,u.jsx)("div",{className:"w-44 h-44 bg-white rounded-xl p-2 mx-auto",dangerouslySetInnerHTML:{__html:qr}}):null;
let secretLine=secret?(0,u.jsxs)("p",{className:"text-xs text-slate-500 text-center break-all",dir:"ltr",children:["secret: ",secret]}):null;
let codeIn=(0,u.jsx)("input",{value:code,onChange:e=>setCode(e.target.value),inputMode:"numeric",placeholder:"رمز ٦ أرقام",className:"w-full px-3 py-2.5 input-glow text-sm text-center tracking-widest",dir:"ltr"});
let startBtn=(0,u.jsx)("button",{onClick:setup,disabled:busy,className:"px-5 py-2.5 rounded-xl bg-gradient-to-l from-sky-500 to-sky-700 text-white text-sm font-medium disabled:opacity-50",children:secret?"إعادة توليد الرمز":"تمكين التحقق الثنائي"});
let confirmBtn=(0,u.jsx)("button",{onClick:enable,disabled:busy,className:"px-5 py-2.5 rounded-xl bg-sky-600 text-white text-sm font-medium disabled:opacity-50",children:busy?"جارٍ...":"تأكيد"});
let enableFlow=(0,u.jsxs)("div",{className:"space-y-3",children:[startBtn,qrBox,secretLine,(0,u.jsxs)("div",{className:"flex gap-2",children:[(0,u.jsx)("div",{className:"flex-1",children:codeIn}),confirmBtn]})]});
let delIn=(0,u.jsx)("input",{value:del,onChange:e=>setDel(e.target.value),inputMode:"numeric",placeholder:"رمز ٦ أرقام",className:"w-full px-3 py-2.5 input-glow text-sm text-center tracking-widest",dir:"ltr"});
let delBtn=(0,u.jsx)("button",{onClick:disable,disabled:busy,className:"px-5 py-2.5 rounded-xl border border-red-500/40 text-red-400 text-sm disabled:opacity-50",children:busy?"جارٍ...":"تعطيل"});
let disableFlow=(0,u.jsxs)("div",{className:"space-y-3",children:[(0,u.jsx)("p",{className:"text-sm text-slate-400",children:"الحماية مفعّلة. لتعطيلها أدخل الرمز الحالي من تطبيق المصادقة."}),(0,u.jsxs)("div",{className:"flex gap-2",children:[(0,u.jsx)("div",{className:"flex-1",children:delIn}),delBtn]})]});
let body=on?disableFlow:enableFlow;
return(0,u.jsxs)("div",{className:"max-w-md rounded-2xl border border-white/10 bg-white/5 p-5 space-y-3",children:[head,desc,body,msgEl]})
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

/* declare the component before its first use, and render it under the
 * change-password card inside the الأمان screen */
spliceOnce("function ui8Security(){", TWO_FA + "function ui8Security(){", "inject ui8TwoFactor");
spliceOnce("children:[hdr,card]})", "children:[hdr,card,(0,u.jsx)(ui8TwoFactor,{})]})", "render 2FA card on الأمان");

fs.writeFileSync(B, c, "utf8");
console.log("bundle written: " + c.length + " bytes");
