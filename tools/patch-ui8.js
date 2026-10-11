/* patch-ui8.js — adds to the app bundle:
 *   ui8Lock      : replaces the whole workspace with a support-only screen once a
 *                  clinic's trial/subscription is over (user.locked from the API)
 *   ui8Services  : clinic owner edits each service's price and duration
 *   ui8Security  : change-password form
 *   plus nav items, page titles and dispatch for the two new views.
 * The staff permission picker already exists in the bundle and is untouched.
 * Idempotent: refuses to run twice.
 */
const fs = require("fs");
const B = "C:\\Users\\911ho\\OneDrive\\Desktop\\clinic\\eyada-clinic-main\\_next\\static\\chunks\\1fds2h4vn64um.js";

const MARK = "ui8-lock-screen";
let c = fs.readFileSync(B, "utf8");
if (c.includes(MARK)) { console.log("already patched, nothing to do"); process.exit(0); }

function splice(anchor, insert, label) {
  const i = c.indexOf(anchor);
  if (i === -1) throw new Error("anchor not found: " + label);
  if (c.indexOf(anchor, i + 1) !== -1) throw new Error("anchor not unique: " + label);
  c = c.slice(0, i) + insert + c.slice(i + anchor.length);
  console.log("  ok  " + label);
}

/* lucide is tree-shaken down to the icons this app already uses, so the two
 * new ones are declared here with the same factory (p.default) before the nav
 * array is evaluated -- inside the array they would read as undefined */
const ICONS = `var ui8IconClock=(0,p.default)("ui8-clock",[["circle",{cx:"12",cy:"12",r:"9",key:"a"}],["path",{d:"M12 7v5l3 2",key:"b"}]]);
var ui8IconShield=(0,p.default)("ui8-shield",[["path",{d:"M12 3l7 3v5c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6l7-3z",key:"a"}]]);
var ui8IconTag=(0,p.default)("ui8-tag",[["path",{d:"M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z",key:"a"}],["circle",{cx:"7.5",cy:"7.5",r:"1.5",key:"b"}]]);
`;

const { COMPONENTS } = require("./ui8-components.js");

console.log("patching bundle");
splice('let xD=[{id:"dashboard"', ICONS + 'let xD=[{id:"dashboard"', "icons (before nav array)");
splice('function xI({currentView:e,setCurrentView:t})', COMPONENTS + "function xI({currentView:e,setCurrentView:t})", "components");

splice(
  'let x=(0,u.jsxs)("div",{className:"flex',
  'if(a.locked)return(0,u.jsx)(ui8LockScreen,{});let x=(0,u.jsxs)("div",{className:"flex',
  "lock gate (sidebar)"
);

/* The sidebar gate alone is not enough: the topbar and the content area are
 * rendered by the parent, so the menus stay in the DOM behind the lock screen.
 * Gate the whole shell instead. */
splice(
  'function x9(){let{user:e}=xM(),',
  'function x9(){if(xM().user?.locked)return(0,u.jsx)(ui8LockScreen,{});let{user:e}=xM(),',
  "lock gate (whole shell)"
);

/* The auth provider only fetched /api/clinics as part of logging in, so after any
 * page refresh the clinic list in the context stayed empty: the management view
 * had no clinic chips, the staff tab could never be opened and the owner could
 * not create accounts. Reload it on mount too. */
splice(
  "let e=await fetch(\"/api/auth/me\");if(e.ok){let t=await e.json();r(t.user),a(t.currentClinicId)}else r(null);",
  "let e=await fetch(\"/api/auth/me\");if(e.ok){let t=await e.json();r(t.user),a(t.currentClinicId);let S=await fetch(\"/api/clinics\").catch(()=>null);if(S&&S.ok){let c=await S.json();Array.isArray(c)&&o(c)}else o([])}else r(null);",
  "clinics on mount"
);

splice(
  '{id:"offers",label:"إدارة العروض"',
  '{id:"services",label:"الخدمات والأسعار",icon:ui8IconTag,permission:"settings",group:"الإدارة"},{id:"security",label:"الأمان",icon:ui8IconShield,permission:"settings",group:"الإدارة"},{id:"offers",label:"إدارة العروض"',
  "nav items"
);

splice(
  '"subscriptions"===t?"super_admin"===a.role||"admin"===a.role:a.permissions?.[t]??!1',
  '("subscriptions"===t||"services"===t)?"super_admin"===a.role||"admin"===a.role:"security"===t?!0:a.permissions?.[t]??!1',
  "nav visibility (security is open to every signed-in user)"
);

splice(
  'offers:{title:"العروض",subtitle:"إدارة العروض والخصومات",icon:eP}',
  'offers:{title:"العروض",subtitle:"إدارة العروض والخصومات",icon:eP},services:{title:"الخدمات والأسعار",subtitle:"سعر ومدة كل خدمة",icon:ui8IconTag},security:{title:"الأمان",subtitle:"كلمة المرور والجلسات",icon:ui8IconShield}',
  "view meta"
);

splice(
  '"offers"===t&&(0,u.jsx)(xY,{})',
  '"offers"===t&&(0,u.jsx)(xY,{}),"services"===t&&(0,u.jsx)(ui8Services,{}),"security"===t&&(0,u.jsx)(ui8Security,{})',
  "dispatch"
);

/* ── appointments: pick the clinic's own service and chain the day by it ────
 * The view below (xL) only let you type two free-form datetime fields, so the
 * owner had no way to say which service the visit was for, and nothing tied
 * the next appointment to the previous one's end. Now the form loads the
 * clinic's menu, the duration follows the chosen service and the start time
 * is offered as 08:00 / 08:20 / 08:40 ... until the end of the day, minus the
 * slots that doctor is already booked for. */
splice(
  "[l,c]=(0,d.useState)([]),[f,p]=(0,d.useState)(!1),[h,m]=(0,d.useState)({})",
  "[l,c]=(0,d.useState)([]),[svcL,setSvc]=(0,d.useState)([]),[f,p]=(0,d.useState)(!1),[h,m]=(0,d.useState)({})",
  "appointments: services state"
);

splice(
  "i.ok&&c((await i.json()).patients||[])};",
  'i.ok&&c((await i.json()).patients||[]),fetch(`/api/services?clinicId=${e}&all=true`).then(x=>x.ok?x.json():[]).then(x=>Array.isArray(x)&&setSvc(x)).catch(()=>{})};',
  "appointments: load the clinic menu"
);

splice(
  'm({type:"regular",patientId:"",doctorId:"",startTime:`${a}T09:00`,endTime:`${a}T09:30`}),p(!0)',
  'm({type:"regular",patientId:"",doctorId:"",serviceId:"",duration:15,startTime:(function(){var q=ui8Slots(a,15,r||[]);return q.length?q[0]:a+"T08:00"})(),endTime:""}),p(!0)',
  "appointments: default to the first free slot"
);

/* the start/end grid is rebuilt wholesale: locate it by its two labels rather
 * than pasting the whole minified run, then swap in the service picker */
const gi = c.indexOf('children:"وقت البداية"');
if (gi === -1) throw new Error("anchor not found: appt start label");
const gs = c.lastIndexOf('(0,u.jsxs)("div",{className:"grid grid-cols-2 gap-3"', gi);
const bi = c.indexOf('children:"وقت النهاية"', gi);
const bEnd = "onChange:e=>m({...h,endTime:e.target.value})})]})";
const be = bi === -1 ? -1 : c.indexOf(bEnd, bi);
if (gs === -1 || be === -1 || c.slice(be + bEnd.length, be + bEnd.length + 3) !== "]})")
  throw new Error("anchor not found: appt time grid");
const gridAnchor = c.slice(gs, be + bEnd.length + 3);
if (c.indexOf(gridAnchor, gs + 1) !== -1) throw new Error("anchor not unique: appt time grid");

const APPT_BLOCK =
  '(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"text-sm font-medium mb-1 block",children:"الخدمة *"}),' +
  '(0,u.jsxs)("select",{className:"w-full px-3 py-2.5 input-glow text-sm",value:h.serviceId||"",' +
  'onChange:e=>{let dd=ui8Dur(svcL,h,e.target.value);' +
  'm({...h,serviceId:e.target.value,duration:dd,endTime:h.startTime?ui8Fmt(new Date(new Date(h.startTime).getTime()+dd*60000)):""})},' +
  'children:[(0,u.jsx)("option",{value:"",children:"اختر الخدمة"}),' +
  'svcL.map(x=>(0,u.jsxs)("option",{value:x.id,children:[x.name," - ",x.durationMin," دقيقة"]},x.id))]})]}),' +
  '(0,u.jsxs)("div",{className:"grid grid-cols-2 gap-3",children:[' +
  '(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"text-sm font-medium mb-1 block",children:"وقت البداية"}),' +
  '(0,u.jsxs)("select",{className:"w-full px-3 py-2.5 input-glow text-sm",' +
  'value:(function(){var list=ui8Slots((h.startTime||"").slice(0,10)||a,ui8Dur(svcL,h),(r||[]).filter(x=>!h.doctorId||x.doctorId===h.doctorId));return list.indexOf(h.startTime)>=0?h.startTime:""})(),' +
  'onChange:e=>{let dd=ui8Dur(svcL,h);m({...h,startTime:e.target.value,endTime:ui8Fmt(new Date(new Date(e.target.value).getTime()+dd*60000))})},' +
  'children:(function(){var list=ui8Slots((h.startTime||"").slice(0,10)||a,ui8Dur(svcL,h),(r||[]).filter(x=>!h.doctorId||x.doctorId===h.doctorId));' +
  'return list.length?list.map(x=>(0,u.jsx)("option",{value:x,children:x.slice(11)},x)):[' +
  '(0,u.jsx)("option",{value:"",children:"لا توجد فترات فارغة"},null)]})()})]}),' +
  '(0,u.jsxs)("div",{children:[(0,u.jsx)("label",{className:"text-sm font-medium mb-1 block",children:"مدة الموعد ونهايته"}),' +
  '(0,u.jsxs)("div",{className:"w-full px-3 py-2.5 input-glow text-sm bg-muted/40 space-y-1",children:[' +
  '(0,u.jsx)("div",{className:"font-bold",children:ui8Dur(svcL,h)+" دقيقة"}),' +
  '(0,u.jsx)("div",{className:"text-xs text-muted-foreground",children:h.startTime?' +
  '"يبدأ "+String(h.startTime).slice(11)+" وينتهي "+String(ui8Fmt(new Date(new Date(h.startTime).getTime()+ui8Dur(svcL,h)*60000))).slice(11):"اختر الوقت"})]})]})]})';

splice(gridAnchor, APPT_BLOCK, "appointments: service picker + chained slots");

/* The owner asked for the same menu inside "نوع الموعد": the registered
 * services show up as a second group of choices, and picking one also drives
 * serviceId + duration so both fields can never disagree. */
splice(
  'value:h.type||"regular",onChange:e=>m({...h,type:e.target.value}),children:[(0,u.jsx)("option",{value:"regular",children:"عادي"}),(0,u.jsx)("option",{value:"follow_up",children:"متابعة"}),(0,u.jsx)("option",{value:"emergency",children:"طوارئ"}),(0,u.jsx)("option",{value:"consultation",children:"استشارة"})]})',
  'value:h.type||"regular",onChange:e=>{let v=e.target.value,x=svcL.find(y=>y.name===v);' +
    'if(x){let dd=Math.max(5,Number(x.durationMin)||15);' +
    'm({...h,type:v,serviceId:x.id,duration:dd,endTime:h.startTime?ui8Fmt(new Date(new Date(h.startTime).getTime()+dd*60000)):""})}' +
    'else m({...h,type:v})},' +
    'children:[(0,u.jsx)("option",{value:"regular",children:"عادي"}),(0,u.jsx)("option",{value:"follow_up",children:"متابعة"}),' +
    '(0,u.jsx)("option",{value:"emergency",children:"طوارئ"}),(0,u.jsx)("option",{value:"consultation",children:"استشارة"}),' +
    'svcL.length?(0,u.jsx)("optgroup",{label:"خدمات العيادة",children:svcL.map(x=>(0,u.jsxs)("option",{value:x.name,' +
    'children:[x.name," - ",x.durationMin," دقيقة"]},x.id))},1):null]})',
  "appointments: clinic menu inside نوع الموعد"
);

/* ── إدارة العيادات: a read-only "الاشتراكات" tab ──────────────────────────
 * The manager could only see the subscription indirectly (the trial badge);
 * now each clinic gets a tab that simply shows plan, term and status. */
splice(
  '[p,h]=(0,d.useState)("info"),[m,x]=(0,d.useState)("")',
  '[p,h]=(0,d.useState)("info"),[subsArr,setSubs]=(0,d.useState)([]),[m,x]=(0,d.useState)("")',
  "clinics: subscription state"
);

splice(
  'let t=await fetch("/api/clinic-subscriptions");if(t.ok){',
  'let t=await fetch("/api/clinic-subscriptions?all=true");if(t.ok){',
  "clinics: subscriptions visible to the site owner"
);

splice(
  "ea(!!r)}",
  "Array.isArray(a)&&setSubs(a),ea(!!r)}",
  "clinics: store the subscription list"
);

splice(
  '["info","users","tasks","booking"].map(',
  '["info","users","tasks","subs","booking"].map(',
  "clinics: subscription tab in the bar"
);

splice(
  '"tasks"===e?"المهام":"رابط الحجز"',
  '"tasks"===e?"المهام":"subs"===e?"الاشتراكات":"رابط الحجز"',
  "clinics: subscription tab label"
);

splice(
  '"tasks"===p&&',
  '"subs"===p&&(0,u.jsxs)("div",{className:"glass-card-v2 rounded-2xl p-6 space-y-4 gradient-border",children:[' +
    '(0,u.jsxs)("div",{className:"flex items-center justify-between",children:[' +
    '(0,u.jsx)("h3",{className:"font-bold",children:"اشتراك العيادة"}),' +
    '(0,u.jsx)("span",{className:"text-[11px] px-2 py-1 rounded-lg bg-muted text-muted-foreground",children:"عرض فقط"})]}),' +
    '(subsArr.filter(x=>x.clinicId===i.id).length?' +
    'subsArr.filter(x=>x.clinicId===i.id).map(ui8SubscriptionCard):' +
    '(0,u.jsx)("p",{className:"text-sm text-muted-foreground",children:"لا يوجد اشتراك مسجّل لهذه العيادة"}))]}),'+
  '"tasks"===p&&',
  "clinics: subscription tab content"
);

/* ── الإشتراكات: the owner switches whole sections off per clinic ────────
 * Same shape as the permissions picker: a clinic that does not want the
 * appointments section turns the chip off, the sidebar drops the item and the
 * API refuses the calls (effectivePermissions() applies the map). */
splice(
  '},D={active:"نشط",expired:"منتهي",cancelled:"ملغي",trial:"تجريبي"};return(0,u.jsxs)("div",{className:"flex-1 p-4 lg:p-6 overflow-y-auto space-y-6 page-transition-enter",children:[',
  '},D={active:"نشط",expired:"منتهي",cancelled:"ملغي",trial:"تجريبي"};return(0,u.jsxs)("div",{className:"flex-1 p-4 lg:p-6 overflow-y-auto space-y-6 page-transition-enter",children:[(0,u.jsx)(ui8ClinicModules,{clinics:o,subs:a,reload:O}),',
  "subscriptions: owner's per-clinic module toggles"
);

fs.writeFileSync(B, c, "utf8");
console.log("\nbundle written: " + c.length + " bytes");