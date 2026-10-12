# سجل التغييرات

الصيغة تتبع [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)،
والإصدارات تتبع [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- سلسلة تجزئة لسجل التدقيق (`prev`/`h`) مع `node server.js --verify-audit`.
- تشفير بايتات ملفات المرضى عند `ENCRYPTION_KEY` (ينقلها `--rotate-key` أيضاً).
- ربط الفواتير بالطبيب والخدمة + تقرير الإيراد حسبهما (JSON وCSV).
- `clinicId` على السجلات الطبية + ترحيل للقديم (كانت سلتّها غير مرئية).
- تدقيق إنشاء/تعديل المريض.
- قوالب طباعة HTML: فاتورة/وصفة/زيارة (`/api/print/…`).
- `/api/metrics` لمالك الموقع + عدّادات الطلبات/الأخطاء/زمن الاستجابة.
- ملفات النشر: `Dockerfile`، `docker-compose.yml`، `.env.example`،
  `nginx/eyada.conf`، `systemd/eyada.service`، `scripts/backup-cron.sh`،
  `docs/DEPLOY.md`، و`npm run check`.
- سياسة التسجيل (`REGISTRATION=open|invite|closed`) + دعوات + حد المعدل
  (3/ساعة) + سقف العيادات التجريبية.
- مزوّد SMTP حقيقي (STARTTLS/AUTH/RFC2047) + `docs/WHATSAPP.md`.
- واجهة مدفوعات (`cash/transfer/mock`) + webhook-HMAC + مفاتيح عدم التكرار.
- الخصوصية: موافقة المريض، سياسة/شروط كل عيادة، تصدير/مسح، احتفاظ تلقائي،
  `--rotate-sessions`، `docs/INCIDENT.md`.
- CSP nonces لكل السكريبتات (أُسقط `unsafe-inline` من `script-src`).

### Fixed
- تسريب وجود الحساب بالزمن في `forgot` (رد فوري + عمل خلفي؛ الفارق 0.01ms).
- `sanitizeInput` كان يقطع ملفات base64 الكبيرة بصمت.
- `POST /api/payments/webhook` كان يُرفض 401 قبل التحقق من التوقيع.
- إقلاع Chrome على CI (`--disable-dev-shm-usage` + انتظار أطول).

### Security
- تشفير الاسم والهاتف للمرضى + فهرس بحث أعمى (`phoneIdx`).
- اشتقاق المفتاح بـ scrypt مع salt دائم + `--rotate-key` آمن.

## [1.0.0] - 2025-10-11

- الإصدار الأول: خادم Node بصفر اعتماديات، صفحة حجز عامة، عزل عيادات،
  جلسات مجزأة، 2FA، سلة مهملات، نسخ احتياطي مشفّر، إشعارات وتذكيرات،
  CI على Node 20 و22.
