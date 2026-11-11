# 8) نظام التحريك

## النموذج

```jsonc
"animation": {
  "enabled": true,
  "duration": 2400,        // مدة الدورة بالميلي ثانية
  "fps": 12,               // يُستخدم في تصدير الإطارات
  "loop": true,            // التكرار اللانهائي في المعاينة
  "tracks": [
    {
      "id": "trk_0",
      "targetId": "obj_xxx",     // معرّف عنصر داخل أي طبقة
      "property": "opacity",
      "keyframes": [
        { "t": 0,    "value": 0, "easing": "easeOut" },
        { "t": 900,  "value": 1, "easing": "easeOut" },
        { "t": 2400, "value": 1 }
      ]
    }
  ]
}
```

## الخصائص القابلة للتحريك

`x`, `y`, `w`, `h`, `opacity`, `rotation`, `scale`, `fontSize`

- `scale` يكبّر العنصر حول مركزه.
- `fontSize` يخصّ النصوص فقط.
- أي خاصية أخرى تُرفض بـ`INVALID_ANIMATION`.

## أنواع التباطؤ

| النوع | المعادلة |
|---|---|
| `linear` | t |
| `easeIn` | t² |
| `easeOut` | 1-(1-t)² |
| `easeInOut` (افتراضي) | تباطؤ متماثل |

## كيف يُحلّ الزمن

1. `time` يُقصّ داخل المدة (مع الالتفاف إذا `loop`).
2. لكل مسار: تُقرأ القيمة بين المفتاحين المحيطين بالزمن مع التباطؤ.
3. النتيجة تُطبَّق على نسخة من المستند أثناء الرسم فقط — **المستند المحفوظ لا يتغير**.

```json
{ "op": "animation.set", "params": { "documentId": "doc_x", "enabled": true, "duration": 2400, "fps": 12, "loop": true } }
{ "op": "animation.addTrack", "params": { "documentId": "doc_x", "targetId": "obj_x", "property": "y",
  "keyframes": [ { "t": 0, "value": 420 }, { "t": 1200, "value": 390 }, { "t": 2400, "value": 420 } ] } }
```

## إضافة مفتاح واحد

```json
{ "op": "animation.addKey",
  "params": { "documentId": "doc_x", "targetId": "obj_x", "property": "x", "time": 600, "value": 240 } }
```

- إذا لم يكن هناك مسار للخاصية يُنشأ مسار بمفتاحين: (0 = القيمة الحالية للعنصر) و(time = القيمة الجديدة).
- إذا كان المسار موجودًا يُستبدل المفتاح عند نفس الزمن أو يُضاف.

## المعاينة

- في الواجهة: زر «تشغيل» يحرّك الزمن بـ`requestAnimationFrame` ويعيد رسم المستند عند كل إطار، وشريط الزمن يسمح بالتوقف عند أي لحظة.
- برمجيًا: `animation.frame { documentId, time, maxWidth }` يعيد صورة PNG (base64) لتلك اللحظة، و`export.image { time }` يصدّرها كملف.
- `static: true` في التصدير يتجاهل التحريك بالكامل.

## الإثبات العملي

في `tests/engine.test.js` (اختبار «animation timeline changes rendered frames») تُصدَّر ثلاث لحظات (0، 500، 1000ms) لبصمة SHA-256 مختلفة لكل لحظة، أي أن الرسم يتغيّر فعليًا مع الزمن — لا مجرد أرقام مخزّنة.

## الفرق بين المعاينة والتصدير

معاينة الواجهة تتم في المتصفح، والتصدير يتم في Node/Skia. كلاهما يستخدم `renderer.js` نفسه، لكن اختيار الخط الاحتياطي قد يختلف قليلًا بين المتصفح وSkia.
لذلك عند الحاجة لدقة نهائية استخدم زر «معاينة المحرّك» (صورة من Node) أو `export.preview`.
