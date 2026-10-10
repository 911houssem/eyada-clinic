/* Components injected into the app bundle by patch-ui8.js.
 *
 * IMPORTANT convention (learned the hard way): this bundle's JSX runtime is
 * React's own, so multiple children MUST be passed as `children:[...]` inside
 * the props object. Writing jsxs(type, props, [a,b,c]) silently turns the
 * array into the element key and React renders an empty node.
 */
function ui8LockScreen(){
let{user:b,logout:t}=xM();
let[msgs,setMsgs]=(0,d.useState)([]),[draft,setDraft]=(0,d.useState)(""),[sending,setSending]=(0,d.useState)(!1),[err,setErr]=(0,d.useState)(""),[ownerEmail,setOwnerEmail]=(0,d.useState)(null),[supportId,setSupportId]=(0,d.useState)(null);
(0,d.useEffect)(()=>{let A=async()=>{let S=await fetch("/api/chat/support").then(F=>F.ok?F.json():null).catch(()=>null);if(!S)return;setOwnerEmail(S.ownerEmail||"911houssem@gmail.com");let id=S.support&&S.support.id;id&&setSupportId(id);let F=await fetch("/api/chat"+(id?"?with="+encodeURIComponent(id):"")).then(F=>F.ok?F.json():null).catch(()=>null);if(!F)return;let T=Array.isArray(F)?F:F&&F.messages?F.messages:[];setMsgs(T.slice(-40))};A()},[]);
async function send(){
let F=draft.trim();
if(!F||sending)return;
setSending(!0);setErr("");
let S=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:F,receiverId:supportId||"support"})}).catch(()=>null);
setSending(!1);
if(S&&S.ok){setDraft("");setMsgs(y=>y.concat([{senderId:b?.id,content:F,_local:!0}]))}else setErr("تعذّر إرسال الرسالة")}
let side=y=>y&&(y.senderId===b?.id||y.userId===b?.id)?"me":y&&y.senderId==="support"?"s":"them";
let bubble=y=>(0,u.jsx)("div",{className:"mb-2 flex "+(side(y)==="me"?"justify-start":"justify-end"),children:(0,u.jsx)("div",{className:"max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed "+(side(y)==="me"?"bg-sky-600 text-white":"bg-white/10 text-slate-200"),children:(0,u.jsx)("p",{className:"whitespace-pre-wrap",children:y.content||y.message||y.text||""})})});
let thread=msgs.length?(0,u.jsx)("div",{className:"max-h-64 overflow-y-auto space-y-1",children:msgs.map(bubble)}):(0,u.jsx)("p",{className:"text-sm text-slate-500",children:"اكتب رسالتك للمالك وسيصلك الرد هنا."});
let inputEl=(0,u.jsx)("input",{value:draft,onChange:F=>setDraft(F.target.value),onKeyDown:F=>{"Enter"===F.key&&!F.shiftKey&&(F.preventDefault(),send())},placeholder:"اكتب رسالتك للمالك...",className:"flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm outline-none focus:border-sky-500"});
let sendBtn=(0,u.jsx)("button",{onClick:send,disabled:sending,className:"px-5 py-2.5 rounded-xl bg-sky-600 text-white text-sm font-medium disabled:opacity-50",children:sending?"جارٍ...":"إرسال"});
let chatHead=(0,u.jsxs)("div",{className:"flex items-center gap-2 text-sm font-medium text-slate-300",children:[(0,u.jsx)(ui8IconClock,{size:16,className:"text-sky-400"}),"محادثة الدعم"]});
let errLine=err?(0,u.jsx)("p",{className:"text-xs text-red-400",children:err}):null;
let chatBox=(0,u.jsxs)("div",{className:"rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3",children:[chatHead,thread,errLine,(0,u.jsxs)("div",{className:"flex gap-2",children:[inputEl,sendBtn]})]});
let badge=(0,u.jsx)("div",{className:"w-16 h-16 mx-auto rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center",children:(0,u.jsx)(ui8IconClock,{size:30,className:"text-amber-400"})});
let title=(0,u.jsx)("h1",{className:"text-2xl font-bold text-center",children:"انتهت الفترة التجريبية"});
let line=(0,u.jsx)("p",{className:"text-sm text-slate-400 text-center",children:"أهلاً "+b?.fullName+"، اشتراك عيادتك غير مُفعَّل حالياً. تم إيقاف كل القوائم، ويمكنك التحدث مع الدعم لإتمام الاشتراك."});
let mail=(0,u.jsx)("a",{href:"mailto:"+(ownerEmail||"911houssem@gmail.com")+"?subject="+encodeURIComponent("تفعيل اشتراك العيادة"),className:"px-4 py-2.5 rounded-xl bg-gradient-to-l from-sky-500 to-sky-700 text-white font-medium",children:"تواصل مع المالك"});
let out=(0,u.jsx)("button",{onClick:t,className:"px-4 py-2.5 rounded-xl border border-white/10 hover:bg-white/5 font-medium",children:"تسجيل الخروج"});
let actions=(0,u.jsxs)("div",{className:"flex flex-wrap gap-3 justify-center",children:[mail,out]});
let head=(0,u.jsxs)("div",{className:"text-center space-y-3",children:[badge,title,line,actions]});
let inner=(0,u.jsxs)("div",{className:"w-full max-w-2xl space-y-5",children:[head,chatBox]});
return(0,u.jsxs)("div",{className:"min-h-screen flex items-center justify-center p-4",children:inner})
}
function ui8Services(){
let{currentClinicId:e}=xM();
let[t,r]=(0,d.useState)([]),[n,a]=(0,d.useState)(""),[o,s]=(0,d.useState)(""),[i,l]=(0,d.useState)(""),[c,f]=(0,d.useState)(""),[m,h]=(0,d.useState)(""),[p,g]=(0,d.useState)("SAR");
let v=async()=>{
if(!e)return;
try{
let S=await fetch("/api/services?all=true");
if(S.ok){let T=await S.json();r((Array.isArray(T)?T:[]).filter(y=>y.clinicId===e))}
}catch(_){}};
(0,d.useEffect)(()=>{v()},[e]);
(0,d.useEffect)(()=>{
if(!e)return;
fetch("/api/clinics?id="+e).then(r=>r.ok?r.json():null).then(r=>{if(r)g((r.clinic||r).currency||"SAR")}).catch(()=>{})
},[e]);
let b=y=>{h(y);setTimeout(()=>h(""),2500)};
let post=async()=>{
if(!n.trim())return void b("اسم الخدمة مطلوب");
if(!i||Number(i)<5)return void b("المدة يجب أن تكون 5 دقائق على الأقل");
let S=await fetch("/api/services",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n.trim(),description:o,durationMin:Number(i),price:Number(m)||0})});
if(S.ok){a("");s("");l("");f("");b("تمت إضافة الخدمة");v()}else b("تعذّرت الإضافة")};
let put=async y=>{
let S=await fetch("/api/services",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:y.id,name:y.name,description:y.description,durationMin:Number(y.durationMin)||30,price:Number(y.price)||0,isActive:y.isActive!==false})});
S.ok?(b("تم حفظ الخدمة"),v()):b("تعذّر الحفظ")};
let del=async y=>{
if(!confirm("حذف الخدمة: "+y.name+"؟"))return;
await fetch("/api/services",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:y.id})});
v()};
let edit=(y,k,val)=>r(t.map(v=>v.id===y.id?Object.assign({},v,{[k]:val}):v));
let numField=(y,k,lbl,min)=>(0,u.jsxs)("div",{className:"relative",children:[(0,u.jsx)("input",{type:"number",min:min,step:"5",value:y[k],onChange:e=>edit(y,k,e.target.value),className:"w-full px-3 py-2 input-glow text-sm pl-12"}),(0,u.jsx)("span",{className:"absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-500",children:lbl})]});
/* must stay a function: t.map() invokes it with (item, index, array) */
let row=y=>{
let nameField=(0,u.jsx)("input",{value:y.name,onChange:F=>edit(y,"name",F.target.value),className:"w-full px-3 py-2 input-glow text-sm font-medium"});
let descField=(0,u.jsx)("input",{value:y.description||"",onChange:F=>edit(y,"description",F.target.value),placeholder:"الوصف",className:"w-full px-3 py-2 input-glow text-xs"});
let saveBtn=(0,u.jsx)("button",{onClick:()=>put(y),className:"px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium",children:"حفظ"});
let delBtn=(0,u.jsx)("button",{onClick:()=>del(y),className:"px-4 py-2 rounded-xl border border-red-500/40 text-red-400 text-sm",children:"حذف"});
let rowBtns=(0,u.jsxs)("div",{className:"flex gap-2",children:[saveBtn,delBtn]});
let textCol=(0,u.jsxs)("div",{className:"space-y-1",children:[nameField,descField]});
return(0,u.jsxs)("div",{key:y.id,className:"rounded-2xl border border-white/10 bg-white/5 p-4 grid grid-cols-1 md:grid-cols-[1fr_7rem_7rem_auto] gap-3 items-end",children:[textCol,numField(y,"durationMin","دقيقة","5"),numField(y,"price",p,"0"),rowBtns]})};
let rows=t.length?(0,u.jsxs)("div",{className:"space-y-3",children:t.map(y=>row(y))}):(0,u.jsx)("div",{className:"text-center text-slate-500 py-10 text-sm",children:"لا توجد خدمات بعد"});
let nameIn=(0,u.jsx)("input",{value:n,onChange:F=>a(F.target.value),placeholder:"اسم الخدمة",className:"px-3 py-2.5 input-glow text-sm"});
let descIn=(0,u.jsx)("input",{value:o,onChange:F=>s(F.target.value),placeholder:"وصف مختصر",className:"px-3 py-2.5 input-glow text-sm"});
let durIn=(0,u.jsxs)("div",{className:"relative",children:[(0,u.jsx)("input",{type:"number",min:"5",step:"5",value:i,onChange:F=>l(F.target.value),placeholder:"المدة",className:"w-full px-3 py-2.5 input-glow text-sm pl-14"}),(0,u.jsx)("span",{className:"absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500",children:"دقيقة"})]});
let priceIn=(0,u.jsxs)("div",{className:"relative",children:[(0,u.jsx)("input",{type:"number",min:"0",step:"5",value:m,onChange:F=>h(F.target.value),placeholder:"السعر",className:"w-full px-3 py-2.5 input-glow text-sm pl-14"}),(0,u.jsx)("span",{className:"absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500",children:p})]});
let addGrid=(0,u.jsxs)("div",{className:"grid grid-cols-1 md:grid-cols-4 gap-3",children:[nameIn,descIn,durIn,priceIn]});
let addBtn=(0,u.jsx)("button",{onClick:post,className:"px-5 py-2.5 rounded-xl bg-gradient-to-l from-sky-500 to-sky-700 text-white font-medium",children:"إضافة الخدمة"});
let msgEl=m?(0,u.jsx)("span",{className:"text-sm "+(m.indexOf("تم")===0?"text-emerald-400":"text-amber-400"),children:m}):null;
let addRow=(0,u.jsxs)("div",{className:"flex items-center gap-3",children:[addBtn,msgEl]});
let addTitle=(0,u.jsx)("h2",{className:"font-semibold",children:"إضافة خدمة"});
let addCard=(0,u.jsxs)("div",{className:"rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3",children:[addTitle,addGrid,addRow]});
let listTitle=(0,u.jsx)("h2",{className:"font-semibold",children:"خدمات العيادة"});
let listCard=(0,u.jsxs)("div",{className:"space-y-3",children:[listTitle,rows]});
let hdr=(0,u.jsxs)("div",{children:[(0,u.jsx)("h1",{className:"v3-page-title",children:"الخدمات والأسعار"}),(0,u.jsx)("p",{className:"v3-page-subtitle",children:"حدّد سعر كل خدمة ومدةvisit. المدة التي تكتبها هنا هي ما يراه المريض في صفحة الحجز، وهي التي تحدّد المواعيد المتاحة."})]});
return(0,u.jsxs)("div",{className:"flex-1 p-4 lg:p-6 overflow-y-auto space-y-6 page-transition-enter",children:[hdr,addCard,listCard]})
}
function ui8Security(){
let{user:e}=xM();
let[t,r]=(0,d.useState)(""),[n,a]=(0,d.useState)(""),[o,s]=(0,d.useState)(""),[i,l]=(0,d.useState)(!1),[c,f]=(0,d.useState)("");
async function m(F){
F.preventDefault();
if(n!==o)return void f("كلمتا المرور غير متطابقتين");
if(n.length<6)return void f("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
l(!0);f("");
let S=await fetch("/api/auth/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:t,newPassword:n})});
l(!1);
let T=await S.json().catch(()=>({}));
if(S.ok){r("");a("");s("");f("تم تغيير كلمة المرور بنجاح")}else f(T.error||"تعذّر تغيير كلمة المرور")}
let field=(lbl,val,set,hint)=>(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"text-sm font-medium block mb-1",children:lbl}),(0,u.jsx)("input",{type:"password",value:val,onChange:x=>set(x.target.value),className:"w-full px-3 py-2.5 input-glow text-sm"}),hint?(0,u.jsx)("p",{className:"text-xs text-slate-500 mt-1",children:hint}):null]});
let cur=field("كلمة المرور الحالية",t,r);
let nw=field("كلمة المرور الجديدة",n,a,"6 أحرف على الأقل");
let cf=field("تأكيد كلمة المرور",o,s);
let mismatch=i&&n!==o?(0,u.jsx)("p",{className:"text-xs text-red-400",children:"كلمتا المرور غير متطابقتين"}):null;
let submit=(0,u.jsx)("button",{type:"submit",disabled:i,className:"w-full px-4 py-2.5 rounded-xl bg-sky-600 text-white font-medium disabled:opacity-50",children:i?"جارٍ...":"تغيير كلمة المرور"});
let msgEl=c?(0,u.jsx)("p",{className:"text-sm "+(c.indexOf("تم")===0?"text-emerald-400":"text-red-400"),children:c}):null;
let form=(0,u.jsxs)("form",{onSubmit:m,className:"space-y-3",children:[cur,nw,cf,mismatch,submit,msgEl]});
let hint=(0,u.jsx)("p",{className:"text-sm text-slate-400",children:"تغيير كلمة المرور يسجّل خروج بقية الأجهزة فوراً."});
let userLine=e&&e.username?(0,u.jsx)("p",{className:"text-xs text-slate-500 mt-4",dir:"ltr",children:"username: "+e.username}):null;
let card=(0,u.jsxs)("div",{className:"max-w-md rounded-2xl border border-white/10 bg-white/5 p-5 space-y-4",children:[hint,form,userLine]});
let hdr=(0,u.jsxs)("div",{children:[(0,u.jsx)("h1",{className:"v3-page-title",children:"الأمان وكلمة المرور"})]});
return(0,u.jsxs)("div",{className:"flex-1 p-4 lg:p-6 overflow-y-auto space-y-6 page-transition-enter",children:[hdr,card]})
}
/* ── appointment slot helpers ─────────────────────────────────────────────
 * The owner picks one of his own services and the appointments screen then
 * chains the whole day by that service's duration: a 20 minute service puts the
 * next free start at 08:20, then 08:40 and so on until the end of the day.
 * Times are handled as local "YYYY-MM-DDTHH:MM" strings so they line up with
 * the datetime-local inputs this view already used.
 */
function ui8Fmt(dt){
  var p=function(n){return String(n).padStart(2,"0")};
  if(!(dt instanceof Date))dt=new Date(dt);
  if(isNaN(dt.getTime()))return"";
  return dt.getFullYear()+"-"+p(dt.getMonth()+1)+"-"+p(dt.getDate())+"T"+p(dt.getHours())+":"+p(dt.getMinutes());
}
function ui8Dur(services,form,id){
  var key=id===undefined?(form&&form.serviceId):id;
  var x=(services||[]).find(function(y){return y&&y.id===key});
  if(!x)return Math.max(5,Number(form&&form.duration)||15);
  return Math.max(5,Number(x.durationMin)||15);
}
function ui8Slots(day,dur,taken){
  var d=Math.max(5,Number(dur)||15),out=[];
  var cur=new Date(String(day||"")+"T08:00");
  if(isNaN(cur.getTime()))return out;
  var stop=new Date(String(day||"")+"T22:00"),list=taken||[];
  while(cur.getTime()<=stop.getTime()){
    var s=cur.getTime(),e=s+d*60000,busy=false;
    for(var i=0;i<list.length;i++){
      var a=list[i]||{},st=String(a.status||"").toLowerCase();
      if(st==="cancelled"||st==="canceled"||st==="no_show")continue;
      var as=new Date(a.startTime).getTime();
      if(!isFinite(as))continue;
      var ae=a.endTime?new Date(a.endTime).getTime():as;
      if(s<ae&&as<e){busy=true;break}
    }
    if(!busy)out.push(ui8Fmt(cur));
    cur=new Date(s+d*60000);
  }
  return out;
}
/* Read-only subscription card shown in the clinic manager's new
 * "الاشتراكات" tab: the owner looks, nothing here writes back. */
function ui8SubscriptionCard(s){
  var ST={active:"فعّال",trial:"تجريبي",expired:"منتهٍ",cancelled:"ملغى",suspended:"موقوف"};
  var tone="active"===s.status?"bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    :"trial"===s.status?"bg-amber-500/15 text-amber-600 dark:text-amber-400"
    :"bg-rose-500/15 text-rose-600 dark:text-rose-400";
  var day=function(v){
    if(!v)return"—";
    var t=new Date(v);
    if(isNaN(t.getTime()))return"—";
    return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");
  };
  var cyc="yearly"===s.billingCycle?"سنوي":"شهري";
  var cells=[["البداية",day(s.startDate)],["النهاية",day(s.endDate)],["الدورة",cyc]];
  if(s.trialEndDate)cells.push(["انتهاء التجربة",day(s.trialEndDate)]);
  return (0,u.jsxs)("div",{className:"border border-border/60 rounded-xl p-4 bg-muted/20 space-y-3",children:[
    (0,u.jsxs)("div",{className:"flex items-center justify-between gap-3",children:[
      (0,u.jsxs)("div",{className:"font-medium",children:[
        (s.plan&&s.plan.name)||"بدون خطة"," ",
        (0,u.jsx)("span",{className:"text-xs text-muted-foreground font-normal",children:"("+cyc+")"})
      ]}),
      (0,u.jsx)("span",{className:"text-[11px] px-2 py-0.5 rounded-full "+tone,children:ST[s.status]||s.status||"—"})
    ]}),
    (0,u.jsx)("div",{className:"grid grid-cols-4 gap-3 text-xs",children:
      cells.map(c=>(0,u.jsxs)("div",{children:[
        (0,u.jsx)("span",{className:"text-muted-foreground block",children:c[0]}),
        (0,u.jsx)("span",{className:"font-medium",children:c[1]})
      ]},c[0]))
    }),
    s.notes?(0,u.jsx)("p",{className:"text-xs text-muted-foreground",children:s.notes}):null
  ]},s.id||"sub");
}

function ui8ClinicModules({clinics,subs,reload}){
  var [busy,setBusy]=(0,d.useState)("");
  var MODULES=[
    ["dashboard","لوحة التحكم"],
    ["patients","المرضى"],
    ["appointments","المواعيد"],
    ["records","السجلات الطبية"],
    ["invoices","الفواتير"],
    ["inventory","المخزون"],
    ["reports","التقارير"],
    ["settings","الإعدادات"]
  ];
  var live=function(id){
    var rows=(subs||[]).filter(function(x){return x&&x.clinicId===id&&(x.status==="active"||x.status==="trial")});
    return rows.find(function(x){return x.status==="active"})||rows[0]||null;
  };
  var on=function(sub,k){return !sub.modules||sub.modules[k]!==false};
  var toggle=function(sub,k){
    if(!sub||busy)return;
    var cur=(sub.modules&&"object"===typeof sub.modules)?sub.modules:{},next={},key;
    for(key in cur) if(Object.prototype.hasOwnProperty.call(cur,key)) next[key]=cur[key];
    if(next[k]===false) delete next[k]; else next[k]=false;
    setBusy(sub.id+":"+k);
    fetch("/api/clinic-subscriptions/"+sub.id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({modules:next})})
      .then(function(r){return r&&r.ok?r.json().catch(function(){return null}):Promise.reject(r)})
      .then(function(){return reload&&reload()})
      .catch(function(){alert("تعذر حفظ وحدات العيادة")})
      .then(function(){setBusy("")});
  };
  var list=(clinics||[]).filter(function(c){return c&&c.id});
  return (0,u.jsxs)("div",{className:"glass-card rounded-2xl p-6 space-y-4",children:[
    (0,u.jsxs)("div",{className:"flex flex-wrap items-center justify-between gap-3",children:[
      (0,u.jsx)("h2",{className:"text-lg font-bold text-foreground",children:"وحدات العيادات"}),
      (0,u.jsx)("span",{className:"text-xs text-muted-foreground",children:"أغلق أي خانة لتشلّها عن العيادة وموظفيها — مثل الصلاحيات"})
    ]}),
    (0,u.jsx)("p",{className:"text-xs text-muted-foreground -mt-2",children:"الخانة المغلقة تختفي من القائمة وترفض خادم أي طلب لها، وللمالك وحده إعادتها."}),
    list.length
      ? (0,u.jsx)("div",{className:"space-y-3",children:list.map(function(c){
          var sub=live(c.id);
          return (0,u.jsxs)("div",{className:"glass-card-v2 rounded-xl p-4 space-y-3",children:[
            (0,u.jsxs)("div",{className:"flex flex-wrap items-center justify-between gap-2",children:[
              (0,u.jsx)("p",{className:"font-bold text-sm text-foreground",children:c.name}),
              sub
                ? (0,u.jsx)("span",{className:"text-[11px] px-2 py-0.5 rounded-lg border "+(sub.status==="active"?"bg-orange-500/15 text-orange-500 border-orange-500/30":"bg-sky-500/15 text-sky-500 border-sky-500/30"),children:sub.status==="active"?"نشط":"تجريبي"})
                : (0,u.jsx)("span",{className:"text-[11px] px-2 py-0.5 rounded-lg border bg-muted text-muted-foreground border-border/40",children:"لا يوجد اشتراك"})
            ]}),
            sub
              ? (0,u.jsx)("div",{className:"grid grid-cols-2 sm:grid-cols-4 gap-2",children:MODULES.map(function(m){
                  var isOn=on(sub,m[0]),isBusy=busy===sub.id+":"+m[0];
                  return (0,u.jsxs)("button",{type:"button",disabled:!!isBusy,onClick:function(){toggle(sub,m[0])},
                    className:"px-2 py-2 rounded-lg text-xs font-bold border transition-all flex items-center justify-center gap-1 "+(isOn?"bg-orange-500/15 text-orange-500 border-orange-500/40":"bg-muted/40 text-muted-foreground border-border/40 opacity-70"),
                    children:[
                      (0,u.jsx)("span",{className:isBusy?"animate-pulse":"",children:isOn?"\u2713":"\u2715"}),
                      (0,u.jsx)("span",{children:m[1]})
                    ]},m[0]);
                })})
              : (0,u.jsx)("p",{className:"text-xs text-muted-foreground",children:"منح اشتراك أولاً لتفعيل وحدات هذه العيادة"})
          ]},c.id);
        })})
      : (0,u.jsx)("p",{className:"text-sm text-muted-foreground",children:"لا توجد عيادات"})
  ]});
}

const SLOT_HELPERS = [
  "function ui8Fmt(dt){var p=function(n){return String(n).padStart(2,\"0\")};if(!(dt instanceof Date))dt=new Date(dt);if(isNaN(dt.getTime()))return\"\";return dt.getFullYear()+\"-\"+p(dt.getMonth()+1)+\"-\"+p(dt.getDate())+\"T\"+p(dt.getHours())+\":\"+p(dt.getMinutes())}",
  "function ui8Dur(services,form,id){var key=id===undefined?(form&&form.serviceId):id;var x=(services||[]).find(function(y){return y&&y.id===key});if(!x)return Math.max(5,Number(form&&form.duration)||15);return Math.max(5,Number(x.durationMin)||15)}",
  "function ui8Slots(day,dur,taken){var d=Math.max(5,Number(dur)||15),out=[];var cur=new Date(String(day||\"\")+\"T08:00\");if(isNaN(cur.getTime()))return out;var stop=new Date(String(day||\"\")+\"T22:00\"),list=taken||[];while(cur.getTime()<=stop.getTime()){var s=cur.getTime(),e=s+d*60000,busy=false;for(var i=0;i<list.length;i++){var a=list[i]||{},st=String(a.status||\"\").toLowerCase();if(st===\"cancelled\"||st===\"canceled\"||st===\"no_show\")continue;var as=new Date(a.startTime).getTime();if(!isFinite(as))continue;var ae=a.endTime?new Date(a.endTime).getTime():as;if(s<ae&&as<e){busy=true;break}}if(!busy)out.push(ui8Fmt(cur));cur=new Date(s+d*60000)}return out}",
].join("\n");

module.exports = { COMPONENTS: [ui8LockScreen, ui8Services, ui8Security, SLOT_HELPERS, ui8SubscriptionCard.toString(), ui8ClinicModules.toString()].join("\n") + "\n" };
