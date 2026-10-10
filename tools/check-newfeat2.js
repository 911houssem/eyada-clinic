const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  <<< ' + JSON.stringify(extra) : '')); } };
const head = (t) => console.log('\n== ' + t);

async function api(path, { method = 'GET', body, token } = {}) {
  const jar = token || '';
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, jar ? { Cookie: jar } : {}),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    if (!kv) continue;
    const key = kv.split('=')[0];
    const bag = new Map((cookies[jar] || '').split('; ').filter(Boolean).map((p) => p.split('=')));
    bag.set(key, kv.slice(key.length + 1));
    cookies[jar] = [...bag].map(([k, v]) => k + '=' + v).join('; ');
  }
  let j = null;
  try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
}
const cookies = {};
const login = async (u, p) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p }, token: 'jar:' + u });
  if (!cookies['jar:' + u]) throw new Error('login failed for ' + u + ' -> ' + r.status + ' ' + JSON.stringify(r.body));
  return { token: cookies['jar:' + u], body: r.body };
};

(async () => {
  const stamp = Date.now().toString().slice(-6);
  const owner = { username: 'zz' + stamp, password: 'probe123', fullName: 'Probe Owner ' + stamp };

  head('1. registration -> 1 hour trial, full permissions, hiring blocked');
  const reg = await api('/api/auth/register', {
    method: 'POST', token: 'jar:probe',
    body: { ...owner, clinicName: 'probe clinic ' + stamp, phone: '0500000000', currency: 'SAR' },
  });
  ok(reg.status === 200, 'register 200', reg.body);
  const me = reg.body.user || reg.body;
  const tok = cookies['jar:probe'];
  const sub = me.subscription;
  ok(me.role === 'admin', 'new clinic owner role=admin', me.role);
  ok(me.roleLabel === 'صاحب عيادة', 'roleLabel is صاحب عيادة', me.roleLabel);
  ok(sub && sub.status === 'trial', 'subscription status=trial', sub);
  ok(sub && sub.canUse === true, 'trial canUse=true');
  ok(sub && sub.canHire === false, 'trial canHire=false');
  ok(me.permissions && Object.values(me.permissions).every((v) => v === true), 'trial owner has every permission', me.permissions);
  const hours = sub && sub.endDate ? (new Date(sub.endDate) - Date.now()) / 36e5 : NaN;
  ok(hours > 0.9 && hours <= 1.05, 'trial ends in ~1 hour (got ' + hours.toFixed(3) + 'h)', sub && sub.endDate);
  const clinicId = me.clinicId || me.currentClinicId || (me.clinic && me.clinic.id);

  head('2. role catalogue');
  const roles = await api('/api/roles', { token: tok });
  ok(roles.status === 200, 'GET /api/roles 200');
  ok(roles.body.permissions.length === 8, '8 permissions exposed', roles.body.permissions && roles.body.permissions.length);
  ok(JSON.stringify(roles.body.grantableRoles) === JSON.stringify(['doctor', 'reception', 'accountant', 'nurse']),
    'clinic owner grantable roles = 4 staff ranks', roles.body.grantableRoles);
  const supRole = roles.body.roles.find((r) => r.id === 'support');
  ok(supRole && supRole.label === 'الدعم' && supRole.grantable === false, 'support rank exists and is not grantable', supRole);

  head('3. trial can use everything except hiring');
  for (const [p, label] of [['/api/dashboard', 'dashboard'], ['/api/patients', 'patients'], ['/api/clinics', 'clinics read'], ['/api/users', 'users'], ['/api/tasks', 'tasks']]) {
    const r = await api(p, { token: tok });
    ok(r.status === 200, 'GET ' + label + ' 200', r.body);
  }
  const hire = await api('/api/users', {
    method: 'POST', token: tok,
    body: { username: 'st' + stamp, password: 'probe123', fullName: 'Probe Staff', role: 'doctor' },
  });
  ok(hire.status === 402, 'POST /api/users during trial -> 402', hire);
  const hireAdmin = await api('/api/users', {
    method: 'POST', token: tok,
    body: { username: 'x' + stamp, password: 'probe123', fullName: 'X', role: 'admin' },
  });
  ok(hireAdmin.status === 402 || hireAdmin.status === 403, 'cannot hire even before the rank check', hireAdmin.status);

  head('4. owner cannot self-activate a paid subscription');
  const cheat = await api('/api/clinic-subscriptions', { method: 'POST', token: tok, body: { clinicId, status: 'active' } });
  ok(cheat.status === 403, 'POST /api/clinic-subscriptions -> 403', cheat);

  head('5. site owner activates the plan, then hiring works with permissions');
  const ownerTok = (await login('admin', 'admin123')).token;
  const act = await api('/api/clinic-subscriptions', {
    method: 'POST', token: ownerTok,
    body: { clinicId, planId: '', status: 'active', endDate: new Date(Date.now() + 30 * 864e5).toISOString() },
  });
  ok(act.status === 200, 'site owner created the paid subscription', act.body);
  const after = await api('/api/auth/me', { token: tok });
  const afterMe = after.body.user || after.body;
  ok(afterMe.subscription && afterMe.subscription.canHire === true, 'canHire flips to true after payment', afterMe.subscription);

  const staffName = 'doc' + stamp;
  const made = await api('/api/users', {
    method: 'POST', token: tok,
    body: {
      username: staffName, password: 'probe123', fullName: 'Probe Doctor', role: 'doctor',
      permissions: { dashboard: true, patients: true, appointments: true, records: false, invoices: true, inventory: false, reports: false, settings: false },
    },
  });
  ok(made.status === 200, 'hiring after payment 200', made.body);
  ok(made.body.permissions.records === false && made.body.permissions.invoices === true,
    'owner grants were stored verbatim', made.body.permissions);
  const badRank = await api('/api/users', {
    method: 'POST', token: tok, body: { username: 'z' + stamp, password: 'probe123', fullName: 'Z', role: 'admin' },
  });
  ok(badRank.status === 403, 'owner cannot mint another owner (403)', badRank);

  head('6. the granted permissions are what the API enforces');
  const stTok = (await login(staffName, 'probe123')).token;
  const cases = [
    ['/api/dashboard', 200], ['/api/patients', 200], ['/api/appointments', 200],
    ['/api/invoices', 200], ['/api/records', 403],
    // there is no /api/reports endpoint (the reports page is built client-side),
    // so 404 here is the correct answer, not a permission leak
    ['/api/reports', 404],
    ['/api/users', 403], ['/api/roles', 403], ['/api/clinics', 200],
  ];
  for (const [p, want] of cases) {
    const r = await api(p, { token: stTok });
    ok(r.status === want, 'staff GET ' + p + ' -> ' + want, r.status);
  }
  const selfPromo = await api('/api/users', { method: 'PUT', token: stTok, body: { id: me.id, permissions: { settings: true } } });
  ok(selfPromo.status === 403, 'staff cannot grant themselves permissions', selfPromo);

  head('7. a clinic may only talk to support');
  const conv = await api('/api/chat?mode=conversations', { token: tok });
  ok(conv.status === 200, 'conversations 200');
  const partners = conv.body.allUsers || [];
  ok(partners.length > 0, 'clinic has a contact', partners.length);
  ok(partners.every((u) => u.role === 'support'), 'every listed contact has the support rank', partners.map((u) => u.role));
  const supportUser = partners[0];
  const ownerRow = (await api('/api/users', { token: ownerTok })).body.find((u) => u.role === 'super_admin');
  const toOwner = await api('/api/chat', { method: 'POST', token: tok, body: { receiverId: ownerRow.id, message: 'hi' } });
  ok(toOwner.status === 403, 'message to the site owner -> 403', toOwner);
  const peek = await api('/api/chat?with=' + ownerRow.id, { token: tok });
  ok(peek.status === 403, 'reading the site owner thread -> 403', peek.status);
  const toSupport = await api('/api/chat', { method: 'POST', token: tok, body: { receiverId: supportUser.id, message: 'probe ticket' } });
  ok(toSupport.status === 200, 'message to support 200', toSupport);
  const readSupport = await api('/api/chat?with=' + supportUser.id, { token: tok });
  ok(readSupport.status === 200 && readSupport.body.messages.length >= 1, 'support thread is readable', readSupport.status);

  head('8. support agent side');
  const supTok = (await login('support', 'support123')).token;
  ok(!!supTok, 'support can sign in');
  const supMe = await api('/api/auth/me', { token: supTok });
  ok(supMe.body.user.role === 'support', 'support role survives login', supMe.body.user.role);
  ok(supMe.body.user.permissions.dashboard === true && supMe.body.user.permissions.patients === false,
    'support: dashboard only', supMe.body.user.permissions);
  const supDash = await api('/api/dashboard', { token: supTok });
  ok(supDash.status === 200, 'support dashboard 200', supDash.status);
  ok((supDash.body.patients || 0) === 0 && (supDash.body.appointments || 0) === 0,
    'support dashboard shows no clinic data', { p: supDash.body.patients, a: supDash.body.appointments });
  ok((await api('/api/patients', { token: supTok })).status === 403, 'support cannot list patients');
  const supConv = await api('/api/chat?mode=conversations', { token: supTok });
  ok(supConv.body.allUsers.length > 1, 'support sees every clinic as a contact', supConv.body.allUsers.length);
  const supToOwner = await api('/api/chat', { method: 'POST', token: supTok, body: { receiverId: me.id, message: 'probe reply' } });
  ok(supToOwner.status === 200, 'support can answer a clinic', supToOwner.status);
  const supRead = await api('/api/chat?with=' + me.id, { token: supTok });
  ok(supRead.status === 200, 'support can read that thread', supRead.status);

  head('9. cleanup');
  const delSelf = await api('/api/users', { method: 'DELETE', token: ownerTok, body: { id: me.id } });
  ok(delSelf.status === 200, 'probe owner removed', delSelf.body);
  const delClinic = await api('/api/clinics', { method: 'DELETE', token: ownerTok, body: { id: clinicId } });
  // there is no DELETE /api/clinics route; the probe clinic is swept from disk afterwards
  ok(delClinic.status === 405 || delClinic.status === 404 || delClinic.status === 200,
    'probe clinic delete attempt answered', delClinic.status);

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });