# واتساب — إعداد Meta WhatsApp Cloud API

يرسل النظام رسائل واتساب **بصيغة قوالب معتمدة فقط** (template messages)، لأن
المحادثات التي تبدأها العيادة يجب أن تستخدم قالباً معتمداً من Meta. لا يُرسل
النظام رسائل نصية حرة عبر واتساب.

## 1. ما تحتاجه من Meta

1. حساب Meta للمطورين + تطبيق فيه منتج **WhatsApp**.
2. رقم هاتف تجريبي (أو رقمك بعد التحقق) — ستحصل على:
   - `Phone Number ID` (رقم `whatsappPhoneNumberId`)
   - `Access Token` (مؤقت للتجربة، أو دائم عبر System User) — يُحفظ في
     `whatsappToken` **مشفراً على القرص** ولا يظهر في أي API.
3. **قوالب معتمدة** (Templates) بالعربية، مثلاً:
   - `book_confirm` — `تم تأكيد حجزك في {{1}} يوم {{2}} الساعة {{3}}.`
   - `reminder_24h` — `تذكير: موعدك في {{1}} غداً {{2}} الساعة {{3}}.`
   - `appt_cancelled` — `تم إلغاء موعدك في {{1}}.`

## 2. الربط من لوحة العيادة

`PUT /api/notifications` (صاحب العيادة) بالحقول:

| الحقل | الوصف |
|---|---|
| `channel` | `"whatsapp-cloud"` |
| `whatsappPhoneNumberId` | رقم المرسل من لوحة Meta |
| `whatsappToken` | التوكن (يُخزَّن مشفراً، ولا يُعاد عرضه — يظهر `whatsappTokenSet: true` فقط) |
| `whatsappLanguage` | لغة القالب (افتراضي `ar`) |
| `whatsappApiBase` | اختياري، افتراضي `https://graph.facebook.com` — للاختبار ضد mock أو وكيل داخلي (يجب أن يبدأ بـ `http(s)://`) |

ربط `templateKey` الداخلي باسم القالب المعتمد يتم عبر `providerTemplates`
(مثال: `{ "booking_confirmation": { "name": "book_confirm", "language": "ar" } }`)،
وبدون ربط يُستخدم `templateKey` نفسه كاسم القالب. المتغيرات تُرتَّب أبجدياً
وتُملأ `{{1}}`, `{{2}}`, … تلقائياً.

تحقق بالإرسال التجريبي:

```bash
curl -s -X POST http://127.0.0.1:3000/api/notifications/test \
  -H 'Content-Type: application/json' \
  -H "Cookie: eyada_session=$SESS" \
  -d '{"to":"0555000001"}'
# {"success":true,"sent":1}
```

## 3. سلوك الإرسال والفشل

- الإرسال غير متزامن عبر طابور (`notificationQueue`) بحد **30 رسالة/دقيقة**
  لكل عيادة، و3 محاولات لكل رسالة بتراجع أسّي (`+2د`, `+4د`) ثم تُعلَّم `failed`.
- `GET /api/notifications` يعرض الطابور (المستلم مقنَّع `***0001`) والسجل —
  **لا يظهر التوكن أبداً** في أي استجابة أو سجل.
- أخطاء Meta (401 توكن خاطئ، 429 تجاوز حد، 5xx) تُسجَّل كنص سبب فقط دون التوكن.

## 4. الحقول التي تحتاجها العيادة من المريض

رقم جوال صالح فقط (`to`) — يُنقَّى تلقائياً إلى أرقام و`+` قبل الإرسال.

## 5. الاختبار المحلي (بدون Meta)

وجّه `whatsappApiBase` إلى خادم وهمي يحاكي `POST /:version/:phoneId/messages`
ويرد `{ "messages": [{ "id": "wamid..." }] }` أو أخطاء 401/429/5xx.
مجموعة `tests/test-whatsapp.js` تفعل ذلك آلياً وتتحقق من إعادة المحاولة
والتراجع وعدم تسريب التوكن.
