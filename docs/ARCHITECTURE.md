# معمارية المشروع — عيادة (Eyada Clinic)

## نظرة عامة

عملية Node.js واحدة، **صفر اعتماديات** (`node:*` المدمجة فقط)، تخدم API
 JSON + ملفات ثابتة + صفحة حجز مولّدة server-side. كل الحالة في الذاكرة،
 والاستمرارية عبر `data/db.json` بكتابة ذرّية (ملف مؤقت + `rename` بعد `fsync`).

```
                ┌────────────────────────────────┐
                │  handle() خط الأنابيب الوحيد   │
                │  nonce-CSP → CORS → rate-limit │
                │  → CSRF/415 → subscription →   │
                │  permission → route handler    │
                └────────┬───────────┬───────────┘
                         │           │
              /api/* (JSON)   ملفات ثابتة + /booking/:slug
                         │
              ┌──────────▼───────────┐
              │  db في الذاكرة       │◄── load() عند الإقلاع
              │  + save()/flush()    │──► db.json (مشفّر جزئياً)
              │  debounced متسلسل    │──► backups/ + audit.log
              └──────────────────────┘
```

## هيكل المجلدات

| المسار | الدور |
|---|---|
| `server.js` (~5700 سطر) | كل شيء server-side: إعداد، تشفير، جلسات، صلاحيات، كل المسارات، التقديم الثابت، الإقلاع |
| `booking-page.js` | مولّد صفحة الحجز العامة (HTML/CSS/JS في ملف واحد، بلا بناء) |
| `notifiers/` | تجريد الإرسال: `console`، `whatsapp-cloud` (حقيقي)، `webhook` (HMAC)، `smtp` (حقيقي net/tls) |
| `payments/` | تجريد الدفع: `cash`، `transfer`، `mock` (+ عقد webhook-HMAC) |
| `scripts/` | `backup.js`/`restore.js` (مكتبة مشتركة)، `check.js` (فحص الصياغة) |
| `lib/` | `qrcode.js` (مكتبة مساعدة للواجهة) |
| `index.html` + `_next/` | غلاف التطبيق + حزمة Next.js المبنية **بلا مصدر** (راجع `docs/FRONTEND.md`) |
| `tests/` (+`cdp.js`) | ~29 مجموعة، كل واحدة تشغّل خادمها الخاص وتطبع `PASS n FAIL n` |
| `tools/` | أدوات تطوير/ترقيع تاريخية (ليست جزء التشغيل) |
| `data/` | `db.json` + الجلسات + التدقيق + النسخ + `files/` (تُنشأ، غير مُضمّنة) |
| `nginx/` `systemd/` `Dockerfile` `docker-compose.yml` | النشر |

## تدفق البيانات (مثال: حجز عام)

1. `GET /booking/:slug` → `buildBookingPage()` مع `D` المحقون + `nonce`.
2. المتصفح يجلب `/api/public/booking/:slug` ثم `/slots?…` (تسلسل حسب مدة الخدمة).
3. `POST /api/public/booking/:slug` → فحص الهاتف/التعارض/قاعدة الزيارة الواحدة
   → إنشاء مريض (إعادة استخدام بالفهرس الأعمى) + موعد + `manageToken` مشفّر.
4. الإشعار يُدرج في `notificationQueue` ويُرسَل بالعامل الدوري (تراجع أسّي).

## نموذج البيانات (مجموعات `db.json`)

`users` (أدوار + صلاحيات + 2FA مختوم)، `clinics` (سياسات/احتجاز/اشتراك)،
`patients` (مشفر الاسم/الهاتف/الطبي + `phoneIdx`)، `appointments`، `records`
(بلا `clinicId` تاريخياً — يُشتق من المريض)، `prescriptions`، `invoices`،
`payments` (ثابتة)، `patientFiles` (بيانات وصفية؛ البايتات في `files/`)،
`services`، `inventory`، `tasks`، `plans`/`clinicSubscriptions`/`offers`،
`notificationConfigs/Queue/Log` (أسرار مختومة)، `inviteCodes`، `resets`
(ملف منفصل)، `sessions` (ملف منفصل، تجزئات فقط).

## الحدود المعروفة (قرارات مثبتة)

- ملف JSON واحد يُحمَّل كاملاً في الذاكرة — مناسب للعيادات الصغيرة/المتوسطة،
  والترحيل العلائقي قرار معلّق (راجع `ROADMAP.md`).
- الفواتير لا تحمل `doctorId` تاريخياً (يُقبل اختيارياً الآن)؛ التقارير تُحسب
  لحظياً من البيانات الحية ولا تُخزَّن.
- سجل التدقيق مربوط التجزئة (`prev`/`h`) ويُتحقق منه بـ `--verify-audit`.
