const fs = require("fs");
const vm = require("vm");
const B = "C:\\Users\\911ho\\Desktop\\bank\\_next\\static\\chunks\\1fds2h4vn64um.js";
const raw = fs.readFileSync(B);
const c = raw.toString("utf8");
const before = fs.readFileSync(B + ".pre-ui8");

console.log("bytes before:", before.length, "-> after:", raw.length, "(delta " + (raw.length - before.length) + ")");
console.log("U+FFFD:", (c.match(/\uFFFD/g) || []).length);

try { new vm.Script(c, { filename: "bundle.js" }); console.log("parse: OK"); }
catch (e) { console.log("parse: FAILED ->", e.message); process.exit(1); }

const anchors = {
  "lock screen component": "function ui8LockScreen()",
  "services view": "function ui8Services()",
  "security view": "function ui8Security()",
  "clock icon": "var ui8IconClock=",
  "shield icon": "var ui8IconShield=",
  "tag icon": "var ui8IconTag=",
  "lock gate": "if(a.locked)return(0,u.jsx)(ui8LockScreen,{});",
  "lock gate (shell)": "function x9(){if(xM().user?.locked)return(0,u.jsx)(ui8LockScreen,{});",
  "clinics on mount": 'let S=await fetch("/api/clinics").catch(()=>null);',
  "appt services state": "[svcL,setSvc]=(0,d.useState)([])",
  "appt menu fetch": "/api/services?clinicId=",
  "appt slot helper": "function ui8Slots(",
  "appt service picker": 'children:"الخدمة *"',
  "appt chained slots": 'children:"مدة الموعد ونهايته"',
  "appt free-slot default": 'q=ui8Slots(a,15,r||[])',
  "appt type menu": 'label:"خدمات العيادة"',
  "clinics subs state": "[subsArr,setSubs]=(0,d.useState)([])",
  "clinics subs fetch": "clinic-subscriptions?all=true",
  "clinics subs tab bar": '["info","users","tasks","subs","booking"]',
  "clinics subs label": '"subs"===e?"الاشتراكات"',
  "clinics subs panel": '"subs"===p&&',
  "subs card": "function ui8SubscriptionCard",
  "subs module toggles": "ui8ClinicModules,{clinics:o,subs:a,reload:O}",
  "subs module card": 'children:"وحدات العيادات"',
  "nav services": 'id:"services",label:"الخدمات والأسعار"',
  "nav security": 'id:"security",label:"الأمان"',
  "visibility rule": '("subscriptions"===t||"services"===t)?',
  "meta services": 'services:{title:"الخدمات والأسعار"',
  "meta security": 'security:{title:"الأمان"',
  "dispatch": '"services"===t&&(0,u.jsx)(ui8Services,{})',
  "support alias call": 'receiverId:supportId||"support"',
  "change-password call": '"/api/auth/change-password"',
  "services api call": '"/api/services?all=true"',
};
let bad = 0;
for (const [k, v] of Object.entries(anchors)) {
  const n = c.split(v).length - 1;
  if (n !== 1) { console.log("  !! " + n + "x  " + k); bad++; }
  else console.log("  ok       " + k);
}
// pre-existing ui7 patch must still be there
console.log("\nui7 markers still intact:", c.includes("911houssem@gmail.com"), c.includes('"subscriptions",label:"إدارة الاشتراكات"'));
console.log("\nRESULT:", bad ? bad + " anchor problem(s)" : "all anchors unique");