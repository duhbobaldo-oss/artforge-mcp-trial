# 9) أمثلة عملية

كل الأمثلة هنا مأخوذة من كود يعمل، ويمكن التحقق منها بتشغيل:

```powershell
cd drawing-tool
node tools/docs-examples.js
```

السيناريو الكامل (ينشئ تصميمًا عربيًا كاملًا) موجود أيضًا كأمر واحد: `node bin/artforge-draw.js demo`.

## 1) عبر HTTP (من أي لغة/أداة)

```bash
# إنشاء مستند
curl -s -X POST http://127.0.0.1:4173/api/op \
  -H "Content-Type: application/json" \
  -d '{"op":"document.create","params":{"name":"بطاقة","width":1080,"height":1080}}'

# رسم مستطيل (استبدل doc_id بالمعرّف الذي عاد)
curl -s -X POST http://127.0.0.1:4173/api/op \
  -H "Content-Type: application/json" \
  -d '{"op":"draw.rect","params":{"documentId":"doc_id","x":60,"y":60,"w":400,"h":240,"radius":28,"fill":"#1e3a5f"}}'

# نص عربي
curl -s -X POST http://127.0.0.1:4173/api/op \
  -H "Content-Type: application/json" \
  -d '{"op":"draw.text","params":{"documentId":"doc_id","x":1020,"y":120,"text":"مرحبا بالعالم","font":{"family":"Amiri","size":72,"weight":700},"align":"right","fill":"#ffffff"}}'

# حفظ ثم تصدير
curl -s -X POST http://127.0.0.1:4173/api/op -H "Content-Type: application/json" -d '{"op":"document.save","params":{"documentId":"doc_id"}}'
curl -s -X POST http://127.0.0.1:4173/api/op -H "Content-Type: application/json" -d '{"op":"export.image","params":{"documentId":"doc_id","format":"png"}}'

# معاينة PNG مباشرة (بدون JSON)
curl -s "http://127.0.0.1:4173/api/documents/doc_id/preview.png?maxWidth=800" -o preview.png
```

## 2) من JavaScript/Node (داخل المشروع)

```js
const path = require('node:path');
const { createEngine } = require('./src/index');

(async () => {
  const engine = createEngine({ root: __dirname });

  const { data: { documentId } } = await engine.run('document.create', {
    name: 'مثال',
    width: 1200,
    height: 800,
    background: {
      type: 'gradient',
      gradient: { type: 'linear', angle: 135, stops: [
        { offset: 0, color: '#0b1220' },
        { offset: 1, color: '#2b1b4d' },
      ] },
    },
  });

  const { data: textLayer } = await engine.run('layer.add', { documentId, name: 'النصوص' });
  const { data: shapeLayer } = await engine.run('layer.add', { documentId, name: 'الأشكال' });

  await engine.run('draw.rect', {
    documentId, layerId: shapeLayer.layerId,
    x: 80, y: 120, w: 1040, h: 470, radius: 36,
    fill: 'rgba(15,23,42,0.62)', stroke: 'rgba(148,163,184,0.35)', strokeWidth: 2,
  });
  await engine.run('draw.ellipse', {
    documentId, layerId: shapeLayer.layerId, x: 140, y: 600, w: 120, h: 120, fill: 'rgba(56,189,248,0.4)',
  });
  await engine.run('draw.line', {
    documentId, layerId: shapeLayer.layerId, x1: 160, y1: 520, x2: 1040, y2: 520,
    stroke: '#38bdf8', strokeWidth: 3, dash: [14, 10], arrow: 'end',
  });
  await engine.run('draw.polygon', {
    documentId, layerId: shapeLayer.layerId,
    points: [{ x: 900, y: 640 }, { x: 980, y: 760 }, { x: 820, y: 760 }],
    fill: 'rgba(168,85,247,0.65)',
  });
  await engine.run('draw.freehand', {
    documentId, layerId: shapeLayer.layerId,
    points: [{ x: 300, y: 680 }, { x: 360, y: 700 }, { x: 420, y: 660 }, { x: 480, y: 720 }],
    stroke: '#f8fafc', strokeWidth: 5,
  });
  await engine.run('draw.path', {
    documentId, layerId: shapeLayer.layerId,
    segments: [{ op: 'M', x: 520, y: 700 }, { op: 'Q', cx: 600, cy: 620, x: 680, y: 700 }],
    stroke: '#f59e0b', strokeWidth: 4, fill: null,
  });

  const { data: headline } = await engine.run('draw.text', {
    documentId, layerId: textLayer.layerId,
    x: 1040, y: 180, text: 'إبداع بلا حدود',
    font: { family: 'Amiri', size: 96, weight: 700, lineHeight: 1.25 },
    align: 'right', fill: '#f8fafc',
    shadow: { color: 'rgba(8,47,73,0.85)', blur: 24, offsetY: 8 },
  });
  await engine.run('draw.text', {
    documentId, layerId: textLayer.layerId,
    x: 1040, y: 340, maxWidth: 700,
    text: 'نص وصفي يلتف تلقائيًا داخل العرض المحدد ويُحاذى يمينًا.',
    font: { family: 'Tajawal', size: 34, lineHeight: 1.55 },
    align: 'right', fill: '#cbd5f5',
  });

  await engine.run('animation.set', { documentId, enabled: true, duration: 2400, fps: 12, loop: true });
  await engine.run('animation.addTrack', {
    documentId, targetId: headline.objectId, property: 'opacity',
    keyframes: [{ t: 0, value: 0, easing: 'easeOut' }, { t: 900, value: 1 }],
  });

  const saved = await engine.run('document.save', { documentId });
  const png = await engine.run('export.image', { documentId, format: 'png', static: true });
  console.log(saved.data.path, png.data.path, png.data.width + 'x' + png.data.height);
})();
```

## 3) تعديل عنصر موجود

```js
// تحريك + تحجيم + دوران
await engine.run('object.transform', {
  documentId, objectId, dx: 40, dy: -20, scale: 1.25, rotation: 15, rotationMode: 'absolute',
});

// تغيير النص والخط
await engine.run('object.update', {
  documentId, objectId,
  patch: { text: 'نص جديد', font: { family: 'Almarai', size: 52, weight: 700 }, align: 'center' },
});

// محاذاة عدة عناصر في وسط اللوحة أفقيًا
await engine.run('object.align', { documentId, objectIds: [id1, id2], align: 'center' });
```

## 4) استعلام الخطوط والقياس قبل الرسم

```js
const fonts = await engine.run('font.list', { arabicOnly: true });
console.log(fonts.data.arabicFamilies, 'عائلة تدعم العربية');

const measured = await engine.run('text.measure', {
  text: 'هل يلتف هذا النص؟',
  font: { family: 'Tajawal', size: 40 },
  maxWidth: 320,
});
console.log(measured.data.lines.length, 'أسطر، ارتفاع', measured.data.contentHeight);
```

## 5) الصور والألوان

```js
const asset = await engine.run('image.add', { path: 'C:/images/pattern.png', name: 'pattern.png' });
await engine.run('draw.image', {
  documentId, x: 80, y: 620, w: 320, h: 160, assetId: asset.data.asset.id, fit: 'cover', radius: 20,
});
const palette = await engine.run('color.palette', { assetId: asset.data.asset.id, count: 5 });
console.log(palette.data.colors.map((c) => c.hex).join(' '));
```

## 6) تراجع وإعادة

```js
await engine.run('history.undo', { documentId });
await engine.run('history.redo', { documentId });
const snapshot = await engine.run('history.state', { documentId });
console.log(snapshot.data.history); // { canUndo, canRedo, undoDepth, redoDepth }
```

## 7) من سطر الأوامر

```powershell
node bin/artforge-draw.js op document.create --params "{\"name\":\"سريع\",\"width\":800,\"height\":600}"
node bin/artforge-draw.js op draw.text --params "{\"documentId\":\"doc_x\",\"x\":760,\"y\":120,\"text\":\"مرحبا\",\"font\":{\"family\":\"Amiri\",\"size\":60}}"
node bin/artforge-draw.js exec ops.json
```

## 8) تشغيل كل ما سبق كتحقق آلي

الملف `drawing-tool/tools/docs-examples.js` ينفّذ الأمثلة (1، 2، 3، 4، 6) على محرّك حقيقي في مجلد مؤقت ويطبع تقريرًا لكل خطوة.
هذا هو المرجع الذي يضمن بقاء هذا الدليل مطابقًا للكود.
