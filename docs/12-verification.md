# 12) التحقق الفعلي ونتائج الاختبار

كل ما يلي نتائج تشغيل حقيقي، وملفات الأدلة محفوظة في مجلد `verification/` بجذر المشروع.

## 1) اختبارات المحرّك وواجهة HTTP

الأمر: `cd drawing-tool && npm test` (يفتح `tests/engine.test.js` و`tests/http.test.js`).
الدليل: `verification/test-output.txt`.

النتيجة: **13 اختبارًا، 13 ناجحًا، 0 فاشل**، تشمل:

1. قدرات المحرّك وقائمة العمليات والخطوط.
2. تشكيل النص العربي (عرض المشكّل < عرض الحروف المنفصلة).
3. التفاف النص والقياس بـ`maxWidth`.
4. الخطوط المضمّنة وكشف العربية + `font.resolve`.
5. دورة كاملة: إنشاء → طبقات → أشكال → نص → حفظ → فتح مرة أخرى من القرص.
6. ترتيب الطبقات والشفافية والإخفاء + تراجع/إعادة.
7. تصدير PNG/JPEG/WebP والتحقق من توقيع كل صيغة في البايتات + مقياس 2×.
8. التحريك: بصمات SHA-256 مختلفة لثلاث لحظات زمنية + تصدير 5 إطارات موجودة على القرص.
9. الأصول: إضافة صورة من data URL + استخراج ألوان + وضعها في المستند.
10. رفض المدخلات الخاطئة بأكواد محددة (`INVALID_NUMBER`, `INVALID_COLOR`, `INVALID_FONT`, `OBJECT_NOT_FOUND`, `LAST_LAYER`, `INVALID_FORMAT`, `UNKNOWN_OP`).
11. واجهة HTTP: صحة، قدرات، خطوط، إنشاء، نص، معاينة PNG (ترويسات + توقيع PNG)، حفظ، تصدير، `/api/batch` مع فشل متوقع.
12. أخطاء HTTP (404/400/403) وحماية path traversal.
13. تحميل الواجهة ونواة الرسم من الخادم + بث SSE يذكر العملية المنفَّذة.

## 2) تحقق الواجهة في متصفح حقيقي

الأمر: `cd drawing-tool && npm run ui-check` (يشغّل Edge بلا واجهة عبر CDP).
الدليل: `verification/ui-check.json` + لقطة `verification/ui-verified.png`.

النتيجة:
```json
{
  "loadedEditor": true,
  "coreBundleLoaded": true,
  "panels": 6,
  "fontOptions": 58,
  "canvasPainted": 57600,
  "drawing": { "rect": true, "text": true, "saved": true },
  "liveViewUpdated": true,
  "consoleErrors": []
}
```

التفسير:
- `fontOptions: 58` = عدد الخطوط القابلة للعربية التي ظهرت في القائمة (بعد التصفية).
- `canvasPainted: 57600` = بكسلات مرسومة فعلًا في مساحة العرض.
- `drawing` = نُفِّذت عمليات رسم نص/مستطيل من داخل الصفحة عبر الـAPI ونجحت وحُفظ التصميم.
- `liveViewUpdated: true` = بصمة بكسلات مساحة الرسم تغيّرت بعد عمليات نُفِّذت من خارج الواجهة (إثبات العرض الحيّ).
- `consoleErrors: []` = لا أخطاء JavaScript في الصفحة.

## 3) العرض التجريبي الكامل

الأمر: `cd drawing-tool && node bin/artforge-draw.js demo`
الدليل: `verification/demo-poster.png` (1200×800).

ينشئ: خلفية متدرجة + تدرّج دائري + 5 دوائر + بطاقة بحواف مستديرة وظل + خط متقطع بسهم + عنوان عربي بخط Amiri + سطرين نص بخط Tajawal + صورة مولّدة (data URL) + مساري تحريك + حفظ + تصدير PNG + لقطة إطار عند 1200ms.
كل الخطوات أعادت `ok: true` وعدد العناصر 12.

## 4) أمثلة الشرح

الأمر: `cd drawing-tool && node tools/docs-examples.js`
الدليل: `verification/docs-examples.txt`.

ينفّذ أمثلة `docs/09-examples.md` على محرّك حقيقي: كل الخطوات `ok: true`، بما فيها `font.list` (55 عائلة عربية) و`text.measure` (سطران بارتفاع 108) والحفظ والتصدير (`1200x800`, 98267 بايت).

## 5) القياسات

الأمر: `cd drawing-tool && npm run measure`
الدليل: `verification/measure-report.json`.

القيم الحقيقية على جهاز الاختبار: تثبيت 36.52MB (منها 35.12MB مكتبة Skia)، RSS بين 80 و83MB،
100 مستطيل في 5.5–5.7ms، تصدير 1920×1080 في 80–98ms. تتفاوت القيم قليلًا بين التشغيلات، والمصدر الدقيق
هو `verification/measure-report.json` الناتج عن آخر تشغيل.

## 7) تحقق المرحلة الثالثة (مكوّن ArtForge AI MCP)

الأوامر:
```powershell
cd artforge-mcp
node bin/artforge-mcp.js index
npm test
node bin/artforge-mcp.js selftest
node bin/artforge-mcp.js selftest --http
```
الأدلة: `verification/mcp-test-output.txt`، `verification/mcp-selftest-stdio.json`،
`verification/mcp-selftest-http.json`، `verification/mcp-design.png`.

النتائج الفعلية:

| الفحص | النتيجة |
|---|---|
| اختبارات MCP (`npm test`) | **7/7 ناجحة** (مصافحة، مراجع، تخطيط، قواعد المراجع، أخطاء، نقل HTTP، خط ①→⑤ كامل) |
| فهرس المراجع | 74 لوحة ألوان + 21 دليل تصميم + 9 كتب + 3 مجموعات تعليمات |
| فحص stdio الكامل | `ok = true`، 8 أدوات، المراحل `1..5 = done`، حُفظ الملف وصُدّرت الصورة، وأُعيدت صورة معاينة داخل رد MCP |
| فحص HTTP | `ok = true`، `protocolVersion = 2025-06-18`، 8 أدوات |
| فرض التسلسل | تنفيذ تصميم بدون `planId` مرفوض برسالة توجّه إلى `artforge_plan_design` |
| تعديل بعد الإنشاء | `object.update` عبر `artforge_tool_op` نجح وغيّر نص العنوان فعليًا |
| التصميم الناتج | 1200×1600، 3 طبقات، 11 عنصرًا، تحريك مفعّل، حفظ + تصدير PNG + معاينة |

`verification/mcp-design.png` هو المخرج الحقيقي لمكوّن MCP: خلفية متدرجة بألوان مستخرجة من المراجع
(لوحة `Color56` و`Color16`)، عنوان عربي بخط Amiri بمحاذاة يمين، سطر وصفي بخط Tajawal، شريط تمييز،
دوائر زخرفية، وقاعدة متقطعة بسهم — كلها نُفِّذت بعمليات الأداة نفسها ثم حُفظت وصُدّرت.

## 8) ما لم يُثبت بعد (شفافية)

- لم يُختبر الأداء على أجهزة أضعف أو أنظمة غير Windows.
- لم يُختبر سلوك التصدير مع 8192×8192 بكسل وعدد كبير جدًا من العناصر (الحد موجود في الكود لكن لم يُقاس زمنه).
- لا توجد اختبارات آلية لتجربة السحب بالماوس في الواجهة (تم التحقق من العمليات والرسم والعرض الحيّ، لا من كل تفاعل سحب).
- جودة تشكيل العربية تعتمد على الخط المستخدم؛ لم تُقارن بصريًا كل الخطوط الـ58.
- ربط ChatGPT الفعلي عبر Connector عام (HTTPS + OAuth) لم يُنشر؛ البروتوكول نُفِّذ وفُحص عبر stdio وHTTP بعميل اختبار حقيقي.
- كتب `THE_BOOK` تُفهرس معرفيًا في `book-index/` (نص + رستر + OCR)؛ لا يوجد فهم دلالي للرسومات، والتحليل البصري قياسات فقط.
- صفحات كثيرة في كتب الرسم لا نص لها؛ تُحلَّل بصريًا وتبقى بلا مفاهيم إن لم يجتز OCR بوابة الثقة (التفاصيل في `verification/book-knowledge-report.md`).

## فهرس معرفة الكتب التسعة (إضافة لاحقة)

| البند | النتيجة المقاسة |
|---|---|
| الصفحات المعالجة | 2004 صفحة من 9 كتب (100%) |
| نص صالح | 1330 صفحة (66.4%) — 1,793,580 حرفًا منظّفًا |
| نص مدمج / OCR | 1147 صفحة نص مدمج، 183 صفحة OCR مقبولة (ثقة ≥ 60 وبوابة جودة) |
| التحليل البصري | 2004 صفحة مرسومة ومحلَّلة (لوحة ألوان + حبر + تباين + حواف) |
| الرسومات المكتشفة | 3143 كائن صورة داخل الصفحات |
| المفاهيم المفهرسة | 351 مفهومًا موزّعة على 37 تصنيفًا |
| سلامة الاقتباسات | 100% — كل اقتباس وُجد فعلًا في صفحته (`node bin/book-index.js verify`) |
| الأصول | بصمات SHA-256 لكل كتاب مطابقة قبل وبعد (`originalsUnchanged: true`) |
| اختبار الاسترجاع | 7 سيناريوهات: كلها استدعت كتابًا مناسبًا، 0 استدعاء غير مرتبط، ≤3 كتب |
| طلب بلا إشارة تصميمية | لم تُستدعَ أي كتب |
| ربط الأداة | كل مفهوم يحمل `toolMapping`؛ ما ليس في الخريطة يبقى توجيهًا فنيًا لا وظيفة |

الأدلة: `verification/book-knowledge-report.md`, `verification/book-knowledge-retrieval.json`,
`verification/book-index-verify.json`, `verification/book-index-tests.txt`,
`verification/mcp-tests-knowledge.txt`.

## إعادة إنتاج كل ما سبق

```powershell
# أداة الرسم
cd drawing-tool
npm install
npm test
npm run demo
npm run measure
node tools/docs-examples.js
npm start            # ثم في نافذة أخرى:
npm run ui-check

# مكوّن MCP
cd ..\artforge-mcp
node bin/artforge-mcp.js index
npm test
node bin/artforge-mcp.js selftest
node bin/artforge-mcp.js selftest --http
node bin/artforge-mcp.js run --prompt "ملصق داكن لورشة تصميم عربي" --headline "إبداع بلا حدود"

# فهرس معرفة الكتب التسعة
cd ..\book-index
npm install
node bin/book-index.js inspect
node bin/book-index.js build          # ≈30–45 دقيقة (رستر + OCR)
node bin/book-index.js verify         # بصمات الأصول + صحة 351 اقتباسًا
node --test tests/index.test.js
node tools/retrieval-demo.js          # 7 سيناريوهات استرجاع + حالة سلبية
node tools/write-report.js            # تقرير القبول العربي
```
