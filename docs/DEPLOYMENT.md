# دليل النشر الإنتاجي (قائمة تحقق)

> التفاصيل الكاملة خطوة بخطوة في [DEPLOY.md](DEPLOY.md). هذه الصفحة قائمة
> التحقق المختصرة قبل فتح الإنتاج.

## المتطلبات

- [ ] خادم Linux + Node.js 20+ (لا `npm install` — صفر اعتماديات).
- [ ] نطاق + شهادة TLS صالحة (`nginx/certs/`).
- [ ] مجلد بيانات خارج النشر (مثلاً `/var/lib/eyada`) بصلاحيات المالك فقط.
- [ ] `.env` مملوء من [.env.example](../.env.example) (**لا يُلتزم أبداً**).

## قائمة ما قبل الإطلاق

- [ ] `NODE_ENV=production` + `ENCRYPTION_KEY` + `BACKUP_ENCRYPT_KEY` أسرار طويلة عشوائية.
- [ ] أول مالك عبر `OWNER_*` أو `--create-owner` (الإقلاع يرفض بدونه).
- [ ] `ORIGIN=https://<النطاق>` و`TRUST_PROXY=1` خلف nginx.
- [ ] `REGISTRATION=closed` (الافتراضي إنتاجياً) + دعوات عند الحاجة.
- [ ] `node server.js --verify-backup` أخضر، وتمرين استعادة واحد ناجح وموثق.
- [ ] cron النسخ الخارجي مفعّل (`scripts/backup-cron.sh`) مع وجهة بعيدة.
- [ ] `/api/health` يرد `dbRead/dbWrite:true`، و`/api/metrics` يُراقَب
      (تنبيه: `backupAgeSec > 86400` أو نمو `queuePending`).
- [ ] تجربة تسجيل دخول + حجز تجريبي + `npm test` أخضر على نسخة الإنتاج.

## التشغيل

- Docker: `docker compose up -d --build` (فحص صحة مدمج على `/healthz`).
- systemd: `systemctl enable --now eyada` (إطفاء لطيف: نسخة + تفريغ).
- عند حادث: `docs/INCIDENT.md` — أول خطوة `node server.js --rotate-sessions`.
