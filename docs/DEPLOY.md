# النشر إلى الإنتاج (من الصفر)

## 1. المتطلبات

- خادم Linux + Node.js 20+ (المشروع **بلا اعتماديات**: لا `npm install`).
- نطاق + شهادة TLS (عبر certbot) — لا تشغّل الإنتاج على HTTP مكشوف.
- مجلد بيانات **خارج** مجلد النشر، مثلاً `/var/lib/eyada`.

## 2. التثبيت (بدون Docker)

```bash
useradd -r -m eyada
git clone <repo> /opt/eyada-clinic && cd /opt/eyada-clinic
cp .env.example .env   # ثم املأ الأسرار (لا تلتزم الملف أبداً)
mkdir -p /var/lib/eyada && chown eyada:eyada /var/lib/eyada
# DATA_DIR=/var/lib/eyada في .env
cp systemd/eyada.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now eyada
```

أول مالك (لا بذر تجريبي في الإنتاج):

```bash
sudo -u eyada OWNER_USERNAME=admin OWNER_PASSWORD='...' node server.js --create-owner
# أو عبر OWNER_* في .env عند أول إقلاع
```

## 3. التثبيت (Docker)

```bash
cp .env.example .env   # املأ الأسرار
mkdir -p nginx/certs   # ضع fullchain.pem + privkey.pem
docker compose up -d --build
curl -sk https://localhost/healthz
```

## 4. بعد الإقلاع — تحقق

```bash
curl -s http://127.0.0.1:3000/api/health        # dbRead/dbWrite/backupAgeSec
node server.js --verify-backup                   # سلامة النسخ
```

## 5. النسخ الاحتياطي الخارجي

الداخلي (`data/backups/`) يغطي `db.json` فقط. لقطة `DATA_DIR` كاملة
(تشمل ملفات المرضى `files/`) عبر cron:

```cron
0 3 * * * /opt/eyada-clinic/scripts/backup-cron.sh >> /var/log/eyada-backup.log 2>&1
```

مع `BACKUP_REMOTE=user@host:/backups/eyada` تُرفع نسخة خارجية تلقائياً.
الاستعادة: أوقف الخادم، فكّ الضغط فوق `DATA_DIR`، ثم
`node server.js --verify-backup` قبل الإقلاع.

## 6. المراقبة والتنبيه

- `GET /api/metrics` (مالك الموقع فقط): طلبات/أخطاء/زمن، عمق الطابور،
  عمر آخر نسخة. اربطه بمنبهك (مثال: `backupAgeSec > 86400` أو
  `queuePending` يتنامى → تنبيه).
- السجلات: `data/server.log` (تدوير 2MB) و`data/audit.log` (تدوير 5MB) —
  تُدوَّران تلقائياً داخل التطبيق.
- عند حادث: اتبع `docs/INCIDENT.md` (`--rotate-sessions` أولاً).

## 7. التشديدات المفعّلة في الإنتاج

`NODE_ENV=production` يفرض: `ENCRYPTION_KEY` إلزامي، بلا بذر تجريبي،
صلاحيات 700/600 (تشمل `backups/` و`files/`)، التسجيل العام `closed`
افتراضياً، وكوكي `Secure`.
