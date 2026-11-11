# 4) مرجع العمليات البرمجية (66 عملية)

كل استدعاء يعيد غلافًا موحّدًا:

```json
{ "ok": true, "op": "draw.rect", "durationMs": 0.42, "data": { "...": "..." } }
```

وفي حال الفشل (عبر HTTP) يعيد الخادم رمز حالة مناسبًا و:

```json
{ "ok": false, "error": { "code": "INVALID_COLOR", "message": "...", "details": { "received": "..." } } }
```

`data` في عمليات المستند تحتوي دائمًا على: `documentId` + `stats` (ملخّص) + `revision` + `op`، مع الحقول الخاصة المذكورة أدناه.

## 4.1 المستندات

| العملية | المدخلات | المخرجات (داخل `data`) |
|---|---|---|
| `document.create` | `width?` (1–8192، افتراضي 1200)، `height?` (افتراضي 800)، `name?`، `background?` (`{type:'solid',color}` أو `{type:'gradient',gradient}` أو `{type:'none'}`)، `dpi?`، `locale?`، `notes?`، `createdBy?`، `animationDuration?`، `compositing?` (`'v2'` افتراضي: الطبقة تُركَّب كوحدة واحدة فلا تتراكم شفافيتها عند تداخل عناصرها؛ `'legacy'` للسلوك القديم) | `document` (كامل)، `documentId` |
| `document.info` | `documentId` | `document`، `history` (`canUndo/canRedo/undoDepth/redoDepth`) |
| `document.list` | — | `documents[]` (`id,name,width,height,layers,objects,animated,modifiedAt,revision`) |
| `document.update` | `documentId`، `name?`، `canvas?{width,height,background,compositing,globalLight{angle,altitude},grid{size,subdivisions,visible}}`، `notes?` | `document`، `changes[]` |
| `document.save` | `documentId`، `path?` (ينتهي بـ `.json` أو `.artforge.json`) | `path`، `bytes`، `stats`، `revision` |
| `document.open` | `path` (مسار ملف على القرص)، `replace?` | `documentId`، `document`، `stats`، `sourcePath`، `version` |
| `document.import` | `document` (كائن التصميم نفسه)، `replace?` | مثل `document.open` (بدون `sourcePath`) |
| `document.duplicate` | `documentId`، `name?` | `documentId` (الجديد)، `sourceDocumentId`، `stats` |
| `document.delete` | `documentId` | `removed` (المعرّف) |
| `document.preview` | `documentId`، `maxWidth?` (افتراضي 900)، `time?`، `static?` | `width`، `height`، `scale`، `sha256`، `base64`، `dataUrl`، `warnings[]` |

```json
POST /api/op
{ "op": "document.create",
  "params": { "name": "بوستر", "width": 1200, "height": 1600,
              "background": { "type": "gradient", "gradient": { "type": "linear", "angle": 135,
                "stops": [ { "offset": 0, "color": "#0b1220" }, { "offset": 1, "color": "#2b1b4d" } ] } } } }
```

## 4.2 التراجع والإعادة

| العملية | المدخلات | المخرجات |
|---|---|---|
| `history.undo` | `documentId` | `document`، `history` |
| `history.redo` | `documentId` | `document`، `history` |
| `history.state` | `documentId` | `history` |

الحد الأقصى 40 خطوة لكل مستند (`drawing-tool/src/core/store.js` → `HISTORY_LIMIT`).

## 4.3 الطبقات

| العملية | المدخلات | المخرجات |
|---|---|---|
| `layer.add` | `documentId`، `name?`، `parentId?` (مجموعة)، `index?` (الموضع بين طبقات الوجهة، 0 = الأسفل؛ دون مجموعات يساوي الترتيب القديم)، `visible?`، `locked?`، `locks?`، `opacity?`، `blend?`، `transform?` | `layer`، `layerId`، `index` |
| `layer.list` | `documentId` | `layers[]` (`index,id,type,name,parentId,depth,siblingIndex,visible,effectiveVisible,locked,effectiveLocked,opacity,blend,objects,children?`) |
| `layer.update` | `documentId`، `layerId`، `name?`، `visible?`، `locked?` (قفل كامل)، `locks?` (`{position?, content?}`: الموضع يمنع التحريك والتحجيم والتدوير والمحاذاة وتحويل الطبقة؛ المحتوى يمنع الإضافة والحذف وتغيير الشكل والتنسيق)، `opacity?`، `fillOpacity?` (شفافية المحتوى وحده؛ المؤثرات تبقى)، `effects?` (استبدال القائمة كلها)، `clipped?` (قناع قص على الطبقة التي تحتها)، `blend?`، `transform?` (المجموعة: الاسم والظهور والقفل والشفافية و`blend` فقط، ويقبل `pass-through`) | `layer`، `changes[]` |
| `layer.move` | `documentId`، `layerId`، `index` (بين طبقات الوجهة الأخرى)، `parentId?` (مجموعة، أو `null` للجذر؛ إن غاب يبقى في مجموعته) | `layerId`، `from`، `to`، `fromParentId`، `parentId` |
| `layer.delete` | `documentId`، `layerId` (حذف مجموعة يحذف محتواها) | `removed`، `removedIds[]` |
| `layer.duplicate` | `documentId`، `layerId`، `name?` (نسخ مجموعة ينسخ محتواها بمعرفات جديدة) | `layer`، `layerId`، `index` |
| `effect.list` | — | `types[]` (النوع وقيمه الافتراضية)، `presets[]`، `order[]` (ترتيب الرسم)، `globalLightDefault` |
| `effect.add` | `documentId`، `layerId`، `effect` (`type`: `dropShadow`، `innerShadow`، `outerGlow`، `innerGlow`، `stroke`، `bevel`، `colorOverlay`، `gradientOverlay`، `patternOverlay`، `extrude` + معاملاته)، `index?` — يتطلب `compositing:'v2'`، لا يعمل على المجموعات | `effectId`، `effect`، `effects[]` |
| `effect.update` | `documentId`، `layerId`، `effectId`، `patch` (لا يغيّر النوع) | `effect`، `changes[]` |
| `effect.remove` | `documentId`، `layerId`، `effectId` | `removed` |
| `effect.move` | `documentId`، `layerId`، `effectId`، `index` (يؤثر فقط بين مؤثرات النوع نفسه؛ ترتيب الأنواع ثابت) | `from`، `to` |
| `effect.applyPreset` | `documentId`، `layerId`، `preset` (`gold`، `chrome`، `glass`، `neon`، `emboss`، `extruded`)، `color?`، `mode?` (`replace` افتراضي أو `append`) | `effectIds[]`، `effects[]` |
| `selection.set` | `documentId`، `shape` (`rect`، `ellipse`، `polygon` (لاسو)، `path`، `all`، `layerAlpha{layerId}`، `colorRange{color, fuzziness 0..200, layerId?}`، `magicWand{x, y, tolerance 0..255, contiguous?, layerId?}`)، `mode?` (`replace`، `add`، `subtract`، `intersect`)، `feather?` | `selection{empty, area, bounds, steps}` |
| `selection.modify` | `documentId`، `modify` (`invert`، `feather`، `grow`، `shrink`، `smooth`)، `radius?` | `selection` |
| `selection.info` / `selection.clear` | `documentId` | `selection`، `program[]` |
| `mask.create` | `documentId`، `layerId` (طبقة أو مجموعة)، `kind?` (`raster` افتراضي أو `vector`)، `from?` (`reveal`، `hide`، `selection`)، `shapes?` (للمتجه)، `invert?`، `density?`، `feather?`، `linked?` | `mask` |
| `mask.paint` | `documentId`، `layerId`، `value` (0 يخفي، 1 يظهر، وما بينهما رمادي)، `shape` (`brush{points,size,hardness}`، `rect`، `ellipse`، `polygon`، `path`، `gradient{from,to}`، `all`، `selection`)، `feather?` | `steps` |
| `mask.update` | `documentId`، `layerId`، `kind?`، `enabled?`، `invert?`، `density?`، `feather?`، `linked?`، `program?` / `shapes?` | `mask`، `changes[]` |
| `mask.delete` | `documentId`، `layerId`، `kind?` | — |
| `mask.apply` | `documentId`، `layerId`، `scale?` (1..4) — إتلافي بطلب صريح: يحوّل محتوى الطبقة إلى صورة واحدة بالقناع؛ قابل للتراجع؛ مرفوض داخل الدفعة الذرية | `assetId`، `objectId`، `destructive:true` |
| `path.anchors` | `documentId`، `objectId` (كائن `path`) | `anchors[]` (`index`، `segment`، `x`، `y`، `in`، `out`، `type`: `corner`/`smooth`) |
| `path.updateAnchor` | `documentId`، `objectId`، `index`، `x?`/`y?` (المقابض تتحرك معها)، `in?`/`out?` (`{x,y}`)، `keepSmooth?` (افتراضي true: المقبض المقابل يبقى على استقامة وبطوله) | `anchors[]` |
| `path.addAnchor` | `documentId`، `objectId`، `segment`، `t?` (0..1، افتراضي 0.5؛ شكل المنحنى لا يتغير) | `anchors[]` |
| `path.deleteAnchor` / `path.convertAnchor` | `documentId`، `objectId`، `index`، `type` (`corner` أو `smooth`، للتحويل) | `anchors[]` |
| `path.boolean` | `documentId`، `objectIds` (2+: `rect`، `ellipse`، `polygon`، `path`)، `op` (`union`، `subtract` الأول ناقص الباقي، `intersect`، `exclude`)، `keepOriginals?`، `name?` — دقيق على المنحنيات (Skia PathOps)، يحترم تحويل الطبقة ودوران الكائن | `objectId`، `layerId`، `removed[]` |
| `path.fromShape` | `documentId`، `objectId` (`rect`، `ellipse`، `polygon`) — نفس الشكل والمظهر كمسار قابل لتحرير النقاط | `objectId`، `converted`، `anchors[]` |
| `guide.update` | `documentId`، `guideId`، `position` | `guide` |
| `history.jump` | `documentId`، `steps` (سالب للتراجع، موجب للإعادة) — `history.state` يعيد الآن `past[]` و`future[]` بأسماء العمليات | `history` |
| `path.outlineStroke` | `documentId`، `objectId` — يحوّل الحد إلى شكل مملوء بالأطراف والزوايا والتقطيع كما تُرسم | `objectId`، `sourceKept` |
| `object.distribute` | `documentId`، `objectIds` (3+)، `axis?` (`horizontal`/`vertical`)، `mode?` (`gaps` مسافات متساوية، أو `centers`) | `order[]` |
| `object.transform` (وضع التحديد) | `documentId`، `objectIds`، `pivot?` (`center` افتراضي، أو `topLeft`…`bottomRight`، أو `{x,y}`)، `scale?` أو `scaleX?`/`scaleY?`، `rotation?` (درجات تُضاف)، `dx?`/`dy?`، `scaleStrokes?` | `objects[]`، `pivot` |
| `document.crop` | `documentId`، `x`، `y`، `width`، `height` — غير إتلافي: يغيّر اللوحة والأصل فقط، والمحتوى خارجها يبقى | `width`، `height`، `shifted` |
| `guide.add` / `guide.remove` / `guide.clear` | `documentId`، `orientation` (`horizontal`/`vertical`)، `position` / `guideId` — تُحفظ مع المستند ولا تُصدَّر | `guide`، `guides[]` |
| `group.create` | `documentId`، `name?`، `layerIds?` (طبقات متجاورة في نفس الأب؛ تأخذ المجموعة مكان أعلاها)، `parentId?`، `index?` (للمجموعة الفارغة)، `opacity?`، `blend?` (`pass-through` افتراضي، أو أي وضع مزج؛ `source-over` = Normal معزولة)، `visible?`، `locked?` — يتطلب `compositing:'v2'`، وأقصى تداخل 10 مستويات | `group`، `groupId`، `childIds[]`، `parentId`، `index` |
| `group.ungroup` | `documentId`، `groupId` | `removed`، `childIds[]`، `parentId`، `discarded` (opacity/blend/visible التي لم تعد تُطبَّق)، `appearanceMayChange` |

- لا يمكن حذف الطبقة الأخيرة (خطأ `LAST_LAYER`).
- `transform` = `{x, y, rotation (درجات), scaleX, scaleY, pivotX, pivotY}`.
- الطبقة المقفلة (`locked: true`) تمنع إضافة أو تعديل العناصر بداخلها (`LAYER_LOCKED`).

## 4.4 رسم العناصر

كل عمليات `draw.*` تقبل اختياريًا: `layerId` (افتراضيًا آخر طبقة)، `index` (موضع داخل الطبقة)، `name`، `opacity`، `rotation`، `blend`، `shadow` `{color,blur,offsetX,offsetY}`.

| العملية | مدخلات خاصة (بالإضافة للاختيارية أعلاه) | المُخرجات |
|---|---|---|
| `draw.rect` | `x, y, w, h`، `radius?` (رقم أو `[tl,tr,br,bl]`)، `fill?`، `stroke?`، `strokeWidth?`، `dash?[]` | `object`، `objectId`، `layerId` |
| `draw.ellipse` | `x, y, w, h`، `fill?`، `stroke?`، `strokeWidth?`، `dash?[]` | نفسها |
| `draw.line` | `x1, y1, x2, y2`، `stroke?`، `strokeWidth?`، `cap?`، `dash?[]`، `arrow?` (none/start/end/both)، `arrowSize?` | نفسها |
| `draw.polygon` | `points[{x,y}]{2,}`، `closed?`، `fill?`، `stroke?`، `strokeWidth?` | نفسها |
| `draw.path` | `segments[{op,x,y,...}]{2,}`، `closed?`، `fill?`، `stroke?`، `strokeWidth?` | نفسها |
| `draw.freehand` | `points[{x,y}]{2,}`، `stroke?`، `strokeWidth?`، `fill?`، `closed?` | نفسها |
| `draw.text` | `x, y, text`، `font?`، `align?`، `rtl?`، `maxWidth?`، `fill?`، `stroke?`، `strokeWidth?` | نفسها |
| `draw.image` | `x, y, w, h, assetId`، `fit?`، `radius?`، `flipX?`، `flipY?` | نفسها |
| `draw.gradient` | `x, y, w, h`، `stops[{offset,color}]{2,}`، `gradientType?` (linear/radial/conic)، `angle?`، `cx?`، `cy?`، `r?`، `radius?`، `blend?`، `blur?` | نفسها |
| `draw.brush` | `points[{x,y,p?}]{2,}`، `color?`، `colors?[]`، `brush{preset,size,spacing,hardness,flow,angle,aspect,jitter,taper,seed}`، `smooth?` (0–1)، `closed?`، `symmetry?{axis,at,atY}`، `repeat?{count,dx,dy}` | نفسها |
| `draw.stroke` | `points[{x,y,p?}]{2,}`، `size?` (8)، `thinning?` (0.6)، `smoothing?` (0.5)، `taperStart?` (0.15)، `taperEnd?` (0.2)، `color?`، `opacity?`، `blend?` | `objectId`، `metrics{length,samples,outlinePoints,maxWidth,minWidth}` — خط عضوي متجهي (مسار مغلق واحد) |

تفاصيل مهمة:

- `draw.text`: `font` = `{family, size, weight, style, lineHeight, letterSpacing}`؛ الحجم 1–2000، الوزن 100..900، `lineHeight` 0.5–5. المحاذاة الافتراضية `right` تلقائيًا إذا كان النص عربيًا. `x` هو حدّ النص الأيمن عند `align:'right'`، والوسط عند `center`، واليسار عند `left`، و`y` هو أعلى سطر.
- `draw.freehand` يحوّل النقاط إلى مسار `M/L` بخط دائري الأطراف. أقل من 3 نقاط في الواجهة لا يُنشئ عنصرًا (تحقق العمليات يقبل نقطتين).
- `draw.path` يقبل `M/L/Q/C/Z` فقط، وأي `op` آخر يُرفض بـ`INVALID_PATH`.
- `draw.freehand` مع `smooth` (0–1) يحوّل النقاط إلى منحنيات Bézier (Catmull-Rom) تمر بالنقاط نفسها.
- كل عنصر يقبل `blur` (0–200px) لتنعيم الحواف والتوهج، و`blend` (26 وضع مزج) يُطبَّق الآن على مستوى العنصر وليس الطبقة فقط.
- `draw.text` يقبل `baseline: "alphabetic"` (فيكون `y` خط قاعدة السطر الأول)، وكل سطر عربي يُرسم داخل عزل اتجاه RTL.
- `draw.brush` إعدادات الفرش: `round, soft, flat, rough, pencil, ink, dotted, dashed, spaced, soft-edge, texture, spray` (`brush.presets`).

```json
{ "op": "draw.text",
  "params": { "documentId": "doc_xxx", "x": 1120, "y": 180,
              "text": "إبداع بلا حدود",
              "font": { "family": "Amiri", "size": 96, "weight": 700, "lineHeight": 1.25 },
              "align": "right", "fill": "#f8fafc",
              "shadow": { "color": "rgba(8,47,73,0.85)", "blur": 24, "offsetY": 8 } } }
```

## 4.5 تعديل العناصر

| العملية | المدخلات | المخرجات |
|---|---|---|
| `object.add` | `documentId`، `layerId?`، `index?`، `object` (كائن كامل بأحد الأنواع السبعة) | `object`، `objectId`، `layerId` |
| `object.update` | `documentId`، `objectId`، `patch` (أي حقول) | `object` (بعد التحقق)، `changed[]` |
| `object.transform` | `documentId`، `objectId`، `dx?`، `dy?`، `x?`، `y?`، `width?`، `height?`، `scale?` (0–50)، `rotation?`، `rotationMode?` (`absolute`افتراضي أو `delta`) | `object`، `previousBox`، `box` |
| `object.align` | `documentId`، `objectIds[]`، `align` (left/center/right/top/middle/bottom)، `relativeTo?` (`canvas`افتراضي أو `selection`) | `aligned[]`، `align` |
| `object.delete` | `documentId`، `objectId` | `removed`، `layerId` |
| `object.duplicate` | `documentId`، `objectId`، `dx?` (24)، `dy?` (24) | `object` (نسخة)، `objectId` |
| `object.list` | `documentId` | `count`، `objects[]` (مع `box` محسوب) |
| `object.measure` | `documentId`، `objectIds?` (افتراضيًا الكل) | `boxes[]` |
| `object.move` | `documentId`، `objectId`، `targetLayerId?`، `index?` | `objectId`، `layerId`، `index` |

- `object.update` يعيد التحقق من الكائن كاملًا بعد الدمج، لذلك لا يمكن إدخال قيمة غير صالحة عبر `patch`.
- `scale` يُطبّق على `w/h` أو حجم الخط أو النقاط أو المقاطع أو سماكة الحد معًا.

## 4.6 النص والخطوط والألوان

| العملية | المدخلات | المخرجات |
|---|---|---|
| `text.measure` | `text`، `font?`، `maxWidth?`، `align?` | `font`، `lines[{text,width}]`، `contentWidth`، `contentHeight`، `lineHeight`، `align`، `rtl` |
| `font.list` | `arabicOnly?`، `limit?` (افتراضي 400) | `total`، `arabicCapable`، `arabicFamilies`، `uniqueFamilies`، `fonts[{family,source,arabic,file?,weight?,style?,license?}]` |
| `font.resolve` | `family` | `requested`، `resolved` (أو `null`)، `arabic` |
| `color.palette` | `assetId` أو `path`، `count?` (1–16، افتراضي 6) | `colors[{hex,rgb,share}]` |
| `color.gradient` | `stops[{offset,color}]{2,}`، `gradientType?`، `angle?` | `gradient` (مطبَّع)، `css` |

`source` في `font.list` يكون `bundled` (مضمّن) أو `system` (مثبّت في النظام).

## 4.7 الصور

| العملية | المدخلات | المخرجات |
|---|---|---|
| `image.add` | `path` (مسار ملف) أو `dataUrl` (base64)، `name?` | `asset{id,file,name,bytes,sha256,createdAt,width,height}` |
| `image.list` | — | `assets[{id,name,bytes,sha256,url}]` |
| `image.remove` | `assetId` | `removed` |

الامتدادات المسموحة: `.png`, `.jpg`, `.jpeg`, `.webp` — والحجم الأقصى 25MB للملف الواحد.

## 4.8 التحريك

| العملية | المدخلات | المخرجات |
|---|---|---|
| `animation.set` | `documentId`، `enabled?`، `duration?` (> 0 ms)، `fps?` (1–60)، `loop?` | `animation` |
| `animation.addTrack` | `documentId`، `targetId` (معرّف عنصر)، `property`، `keyframes[{t,value,easing?}]{2,}` | `track`، `animation` |
| `animation.addKey` | `documentId`، `targetId`، `property`، `time?`، `value`، `easing?`، `baseValue?` | `track`، `animation` |
| `animation.removeTrack` | `documentId`، `trackId` | `removed` |
| `animation.clear` | `documentId` | `animation` |
| `animation.info` | `documentId` | `animation`، `trackCount`، `supportedProperties[]` |
| `animation.frame` | `documentId`، `time?`، `maxWidth?` | `time`، `width`، `height`، `sha256`، `dataUrl`، `base64` |

الخصائص القابلة للتحريك: `x, y, w, h, opacity, rotation, scale, fontSize`.
أنواع التباطؤ: `linear, easeIn, easeOut, easeInOut`.

## 4.9 التصدير

| العملية | المدخلات | المخرجات |
|---|---|---|
| `export.image` | `documentId`، `format?` (png/jpeg/webp)، `scale?` (0<–4)، `quality?` (0<–1، لـjpeg/webp)، `time?`، `static?`، `outPath?` | `path`، `bytes`، `format`، `mime`، `width`، `height`، `scale`، `sha256`، `warnings[]` |
| `export.svg` | `documentId`، `outPath?` (ينتهي بـ .svg)، `inline?` | `svg` أو `path`، `vectorObjects`، `textObjects`، `rasterized[]`، `warnings[]` — SVG قابل للتحرير |
| `export.frames` | `documentId` (بتشغيل تحريك مفعّل)، `outDir?`، `scale?`، `fps?` | `frames` (عدد)، `fps`، `duration`، `dir`، `files[{index,time,path,bytes,sha256}]` |
| `export.preview` | `documentId`، `maxWidth?`، `time?`، `static?` | `width`، `height`، `scale`، `sha256`، `dataUrl`، `warnings[]` |
| `export.psd` | `documentId`، `outPath?` (ينتهي بـ .psd) | `path`، `bytes`، `colorProfile`، `layers`، `lossless`، `report[]` — PSD بحدود معلنة (انظر أدناه) |
| `document.importPsd` | `path` (.psd) أو `base64`، `name?` | `documentId`، `layers`، `groups`، `colorProfile`، `lossless`، `report[]` |
| `export.bundle` / `project.import` | `documentId`، `outPath?` / `base64` | حزمة المشروع تحمل الآن مربعات البكسل `tiles/<sha256>.png` ويُتحقق من كل مربع بتجزئته |

- `static: true` يتجاهل التحريك ويصدّر الحالة الأساسية للتصميم (مفيد للملصقات).
- إدارة الألوان: `document.create {colorProfile}` و`document.update {canvas:{colorProfile}}` بقيم `srgb` (افتراضي) و`display-p3` و`adobe-rgb` (تعيين ملف دون تحويل). `export.image {convertTo?, icc?}`: `convertTo` يحوّل البكسلات رياضيًا (مصفوفة + منحنى نغمي، تكييف Bradford إلى D50)؛ يُضمَّن ملف ICC v2.1 في PNG (iCCP) وJPEG (APP2) تلقائيًا لغير sRGB، وsRGB يبقى بلا وسم كما كان. WebP لا يحمل ICC (تحذير). التحقق المستقل: LittleCMS يقرأ الملفات المولدة ويطابق التحويل بفرق 0.
- بدون `outPath` يُكتب الملف في `drawing-tool/data/exports/`.
- `outPath` النسبي يُحلّ مقابل جذر المشروع.

## 4.9.1 التخطيط الآلي والفحص

| العملية | المدخلات | المخرجات |
|---|---|---|
| `layout.table` | `columns[{title,format?,align?,width?,decimals?,currency?}]`، `rows[[…] أو {kind,cells}]`، `x?, y?, width?, maxHeight?`، `font?`، `headerFont?`، `theme?`، `padding?`، `rtl?`، `digits?`، `zebra?`، `startRow?`، `repeatHeader?`، `name?` | `objectIds[]`، `height`، `headerHeight`، `rowsDrawn`، `nextRow`، `columns[]`، `rtl`، `warnings[]` |
| `layout.flow` | `blocks[{type:heading،paragraph،list،table،spacer,…}]`، `x?, y?, width?, height?`، `font?`، `headingFont?`، `color?`، `headingColor?`، `markerColor?`، `ruled?{spacing,top,color,lineWidth,margin,lift}`، `rulesLayerId?`، `start?{block,line}`، `blockGap?`، `headingGap?` | `objectIds[]`، `rulesObjectIds[]`، `cursor` (null عند الاكتمال)، `done`، `pitch`، `rules[]`، `lines[{block,line,baseline,rule,size,ascent,descent,text}]`، `tables[]`، `warnings[]` |
| `draw.ruledPaper` | `spacing`، `top?`، `x?, y?, width?, height?`، `color?`، `lineWidth?`، `margin?{offset,color,width} أو false`، `rtl?` | `objectIds[]`، `rules[]`، `spacing` |
| `brush.presets` | — | `presets[]`، `parameters[]` |
| `image.analyze` | `assetId` أو `path`، `count?` | `assetId`، `colors[]`، `width`، `height`، `aspect`، `meanBrightness`، `tone`، `grid[9]`، `calmestCell`، `busiestCell`، `balance` |
| `qa.check` | `documentId`، `ruled?{layerId,rules[],sizes[],pitch,tolerancePx?}` | `ok`، `issues[{code,…}]` (TEXT_OUTSIDE_CANVAS, TEXT_WORD_OVERFLOW, LOW_CONTRAST, TEXT_OVERLAP, RULED_MISALIGNED)، `ruled{…}` |
| `qa.visibility` | `documentId`، `groups[{id, objectIds[], box?}]`، `scale?` (افتراضيًا حتى 480px)، `threshold?` (18) | `groups[{id, changedRatio, changedPixels, meanDelta, box}]`: نسبة بكسلات صندوق المجموعة التي تتغير فعلًا عند حذفها (مخفي تحت طبقات لاحقة أو بلون خلفيته = منخفض) |
| `batch` | `ops[{op,params}]` (حتى 2000)، `atomic?` (`true`: الكل أو لا شيء؛ عند الفشل تعود المستندات وسجل التراجع كما كانت وتُحذف المستندات التي أنشأتها الدفعة؛ تُرفض مسبقًا العمليات ذات الأثر خارج المستند: الحفظ والفتح والاستيراد والحذف والتصدير والأصول والتراجع)، `expectedRevisions?` (`{documentId: revision}`) | `count`، `results[]`، `atomic`؛ عند الفشل `details.batchIndex`، `completed`، `rolledBack` |
| (أي عملية على مستند) | `expectedRevision?` مع `documentId` | تُرفض بـ `REVISION_CONFLICT` إن تغيّر المستند منذ قراءة `revision` |

- `layout.*` تضيف كل عناصرها كخطوة تراجع واحدة، وتعيد مؤشر متابعة (`nextRow` أو `cursor`) لتقسيم المحتوى على صفحات.
- `qa.check` يقيس البكسلات المرسومة؛ التباين يُقاس مقابل الخلفية بعد إخفاء النصوص، ومحاذاة الورق المسطر تُقاس من صف الحبر الأكثف فوق كل خط.

## 4.10 النظام

| العملية | المدخلات | المخرجات |
|---|---|---|
| `system.capabilities` | — | `name`، `version`، `engine{runtime,renderer,shaping}`، `limits`، `fonts{total,arabicCapable,bundledArabic,systemArabic}`، `objectTypes[]`، `blendModes[]`، `animationProperties[]`، `operations[{name,description}]`، `features{}` |
| `system.stats` | — | `uptimeSeconds`، `node`، `platform`، `memory{rssMb,heapUsedMb,externalMb}`، `documents`، `assets`، `assetBytes`، `cpuCount` |

## 4.11 نقاط HTTP

| المسار | الوصف |
|---|---|
| `GET /` | محرّر الواجهة |
| `GET /ui/*` | ملفات الواجهة (`app.js`, `styles.css`) |
| `GET /core.bundle.js` | نواة الرسم المشتركة للمتصفح (مبنية من مصادر Node) |
| `GET /api/health` | حالة الخادم |
| `GET /api/capabilities` | نفس مخرجات `system.capabilities` |
| `GET /api/stats` | نفس مخرجات `system.stats` |
| `GET /api/ops` | قائمة العمليات |
| `GET /api/fonts?arabicOnly=1` | قائمة الخطوط |
| `GET /api/log` | آخر 120 عملية/حدث |
| `GET /api/documents` | قائمة المستندات |
| `GET /api/documents/:id` | مستند كامل |
| `GET /api/documents/:id/preview.png?maxWidth=&time=` | صورة معاينة من محرّك Node (ترويسات `X-ArtForge-Revision` و`X-ArtForge-Sha256`) |
| `GET /api/events[?documentId=]` | بث أحداث SSE (عمليات + تغييرات المستند) |
| `POST /api/op` | تنفيذ عملية: `{ op, params }` |
| `POST /api/batch` | تنفيذ عدة عمليات: `{ ops:[{op,params}], stopOnError?:true, atomic?:false }` (`atomic:true` يمر عبر عملية `batch` بالتراجع الكامل) |
| `GET /fonts/*.ttf` | الخطوط المضمّنة فقط |
| `GET /assets/*` | الصور المضافة |
| `GET /exports/*` | الملفات المصدَّرة |

`/api/batch` يتوقف عند أول فشل ما لم يُمرَّر `stopOnError: false`، ويعيد `results[]` لكل خطوة مع رمز الخطأ.



## 4.12 الواقعية والتشطيب (جولة 2026-10-31)

| العملية/الخاصية | المدخلات | الوصف |
|---|---|---|
| `draw.form` | `shape (rect/ellipse/polygon/path)`، `x,y,w,h` أو `points[]`، `fill`، `lightAngle?` (225)، `shade?`، `shadeDepth?`، `soft?` (0.35)، `highlight?`، `texture?`، `gloss?`، `outline?`، `lineColor?` | يضيف جسمًا مكتملًا (ظل، وجه مضاء، لمعة، ملمس، محيط) كعناصر مسمّاة `name:shadow/lit/highlight/...` |
| `fill: {type:"pattern"}` | `kind` (hatch, crosshatch, dots, stripes, grain, paper, brick, tiles, wood, noise)، `color`، `background?`، `scale?`، `angle?` | تعبئة إجرائية؛ الدوران حول مركز الشكل دون تحريك محيطه |
| تدرج `smooth` | `smooth: true` أو `easing` | استيفاء OKLab (8 محطات لكل مقطع) |
| `clip` لأي عنصر | `{type:"rect"|"ellipse"|"path", ...}` | قصّ العنصر داخل منطقة |
| `layer.add/update` `filter` | `{blur, brightness, contrast, saturate, grayscale, sepia, hueRotate, invert}` | مرشّح على الطبقة كاملة (تُرسم في لوحة خفية ثم تُركّب) |
| `canvas.effects` | مصفوفة `{type: haze|grade|bloom|vignette|tint|grain|paper, ...}` | تشطيب الصورة كاملة بعد كل الطبقات؛ `bloom.threshold` (0.68) يحدد الإضاءات التي تتوهج |
| `draw.brush` presets | `smudge, oil, watercolor, chalk, charcoal, marker` + `wet, pickup, colorJitter, edge, grains` | مزج رطب حقيقي بأخذ عينات من اللوحة تحت الفرشاة (18 إعدادًا) |
| `batch` | `ops[]` | لقطة تراجع واحدة للدفعة كاملة |

## مؤثرات الطبقة (Layer Styles)

- المؤثرات حية: تُحسب عند كل رسم من ألفا محتوى الطبقة بعد تركيبه، ولا تُخزن صورًا؛ تعديل النص أو الشكل يعيد حسابها، ويبقى النص نصًا حيًا.
- ترتيب الرسم ثابت كما في فوتوشوب (من الأسفل): `dropShadow`، `outerGlow`، `extrude`، المحتوى × `fillOpacity`، `patternOverlay`، `gradientOverlay`، `colorOverlay`، `innerGlow`، `innerShadow`، `bevel`، `stroke`. تكرار النوع نفسه يُرسم بترتيب القائمة.
- الحواف تقاس بحقل مسافة إقليدي دقيق: عرض `stroke` و`spread`/`choke` وخريطة ارتفاع `bevel` بالبكسل الفعلي. الظلال بتمويه غاوسي (sigma = size / 2) والتوهج بتلاشٍ ناعم على المسافة؛ النتيجة تقارب سلوكي لا تطابق خوارزمية Adobe.
- `canvas.globalLight {angle, altitude}` (افتراضي 120° / 30°) تتبعه كل المؤثرات ذات `useGlobalLight`؛ الزاوية بعكس عقارب الساعة من اليمين، والظل يسقط بعكس اتجاه الضوء.
- `fillOpacity` يخفي المحتوى ويُبقي المؤثرات؛ الظل لا يظهر تحت الشكل (`knockout`، الافتراضي).
- الأحجام بوحدات المستند وتتضاعف مع مقياس التصدير.
- SVG/PDF: الطبقة ذات المؤثرات تُصدَّر صورةً لتلك الطبقة مع تحذير صريح؛ الطبقات الأخرى تبقى متجهات.
- `satin` (P8): نسختان من ظل الشكل المموّه مزاحتان باتجاهين متعاكسين على `angle` بمسافة `distance`، والفرق بينهما يمر عبر `contour` (افتراضي `gaussian`) ثم `invert` (افتراضي مفعّل)، ويُرسم داخل الشكل فقط. ترتيبه بعد `colorOverlay`.
- `contour` (P8) اختياري على `dropShadow` و`innerShadow` و`outerGlow` و`innerGlow` و`bevel` (شكل الحافة) و`satin`: اسم جاهز (`linear`، `gaussian`، `cone`، `coneInverted`، `cove`، `halfRound`، `ring`، `ringDouble`، `rollingSlope`، `sawtooth`) أو 2–16 نقطة `[دخل، خرج]` من 0..255 بمنحنى spline طبيعي. `linear` لا يُخزَّن.
- المؤثرات على المجموعات: تُطبَّق على ناتج المجموعة المركّب (تُعزل المجموعة لتُنسَّق ثم تُركَّب مرة واحدة؛ Pass-through يصبح عاديًا لهذا الغرض). `fillOpacity` و`blendIf` غير مدعومين على المجموعات.

## الأقنعة والقص والتحديد

- القناع النقطي برنامج تغطية قابل لإعادة التشغيل: كل خطوة ترسم قيمة رمادية (0 يخفي، 1 يظهر) بشكل أو فرشاة أو تدرج، أو تتقاطع، أو تعدّل (`invert`، `feather`، `grow`، `shrink`، `smooth`). يُحفظ في المستند ويُتراجع عنه، ويُرسم بأي دقة.
- القناع المتجه أشكال قابلة للتحرير بالأرقام. إذا وُجد القناعان تُضرب تغطيتهما.
- القناع يشكّل الطبقة قبل مؤثراتها (حدها وظلها يتبعان الحافة المقنّعة). المرتبط يتبع تحويل الطبقة، وغير المرتبط يبقى في إحداثيات المستند.
- للمجموعات أقنعة أيضًا، في وضع Pass-through والوضع المعزول.
- قناع القص (`clipped`): الطبقة تظهر فقط حيث لمحتوى الطبقة غير المقصوصة تحتها في الأب نفسه ألفا؛ تُمزج مع قاعدتها كمجموعة وتأخذ شفافية القاعدة ووضع مزجها؛ إخفاء القاعدة يخفي المجموعة. ويمكن القص على مجموعة: القاعدة هي ناتج المجموعة المركّب (قبل مؤثراتها).
- التحديد حالة تحرير مؤقتة لكل مستند: لا يُحفظ ولا يدخل سجل التراجع (لكنه يعود مع تراجع الدفعة الذرية). نطاق اللون والعصا السحرية وشفافية الطبقة تُؤخذ من البكسلات لحظة التنفيذ وتُخزن مضغوطة.
- تصدير SVG/PDF: الطبقة المقنّعة ومجموعة القص والمجموعة المقنّعة تُصدَّر صورة مع تحذير؛ الباقي متجهات.

## أوامر التحرير (P4a)

- `align` و`distribute` و`object.transform` تحرك الهندسة الفعلية لكل نوع (النقاط والمقاطع والخطوط)؛ قبل ذلك كانت المحاذاة تغيّر `x`/`y` فقط فلا تتحرك المسارات والمضلعات.
- `object.transform` بكائن واحد ودون `objectIds`/`pivot` يبقى بسلوكه السابق كما هو.
- الأشكال تحفظ الآن `lineCap` (`butt`/`round`/`square`) و`lineJoin` (`miter`/`round`/`bevel`)؛ كانت تُسقط عند الحفظ فلا تصل إلى الرسم.
- الأوامر نفسها هي ما ستستخدمه واجهة المحرر (P4b): مقابض التحويل وتحرير النقاط والالتقاط.

## واجهة المحرر (P4b)

- التحديد: نقر، Shift للإضافة، سحب مساحة، Ctrl+A. مقابض تحجيم (الزوايا تحفظ النسبة، Ctrl يحررها، Alt من المركز) ومقبض تدوير (Shift بخطوات 15°). الأسهم تحرك 1px وShift+سهم 10px.
- الالتقاط إلى الأدلة والشبكة وحواف اللوحة ومركزها وحواف العناصر ومراكزها، مع خطوط إرشاد.
- أداة تحرير النقاط (A): سحب النقاط والمقابض، Alt+نقر للتحويل حاد/ناعم، نقر مزدوج على المسار لإضافة نقطة، Delete لحذفها.
- لوحات: الطبقات (مجموعات، أقنعة، مؤثرات، قص، أقفال)، الطبقة، المؤثرات، الترتيب والأشكال، العرض والأدلة، السجل. كل لوحة تُطوى بالنقر على عنوانها.
- كل تعديل في الواجهة يمر بالعمليات نفسها التي يستخدمها ChatGPT؛ الحركات متعددة الطبقات دفعة ذرية واحدة وخطوة تراجع واحدة.

## طبقات البكسل والرتوش (P5 + P8)

| العملية | المدخلات | ملاحظات |
|---|---|---|
| `raster.create` | `name?`، `fill?`، `parentId?`، `index?` | طبقة بكسل؛ البكسلات مربعات 256×256 مخزنة بتجزئتها (`assets/tiles/<sha256>.png`)، والمستند يحمل خريطة صغيرة فقط |
| `raster.rasterize` | `layerId` | إتلافي بطلب صريح: الأشكال والنص إلى بكسلات؛ المؤثرات والقناع والشفافية تبقى حية |
| `raster.paint` | `layerId`، `tool` (brush، eraser، clone، heal، dodge، burn، sponge، smudge، blur، sharpen)، `points[{x,y,p?}]`، `size`، `hardness`، `opacity`، `flow`، `color` للفرشاة، `source{x,y}` للاستنساخ والمعالجة، `range`/`exposure` للتفادي والحرق، `mode` للإسفنج | يحترم التحديد وقفل الشفافية |
| `raster.fill` | `layerId`، `x`، `y`، `color`، `tolerance?`، `contiguous?` | دلو الطلاء |
| `raster.gradient` | `layerId`، `from`، `to`، `stops`، `type?` | داخل التحديد إن وُجد |
| `raster.clear` | `layerId` | |
| `raster.spotHeal` | `layerId`، `points[]`، `size` (2..400) | لكل بقعة يُختار مصدر مجاور بمطابقة الحلقة المحيطة، ثم دمج في مجال التدرج (حل لابلاس) فلا يبقى لون البقعة نفسها |
| `raster.patch` | `layerId`، `offset{x,y}?` | يعالج التحديد الحالي من منطقة مصدر (أو يختارها تلقائيًا) |
| `raster.transform` | `layerId`، `mode`: `perspective`/`distort` + `corners[4]`، أو `skew` + `skewX`/`skewY`، أو `warp` + `preset` (arc، arch، bulge، flag، wave، fisheye، rise، squeeze، twist) + `bend` (-1..1)، أو `mesh` + `rows`، `cols`، `points` | تحويل إتلافي لبكسلات الطبقة كما في فوتوشوب على طبقة عادية؛ ربط عكسي لكل بكسل وحواف مصقولة بالعينات |

## الضبط غير الإتلافي والفلاتر الذكية (P6)

- `adjustment.add {kind | adjustment, from?:'selection', clipped?, opacity?, blend?}` و`adjustment.update {layerId, adjustment}`. الأنواع: curves (spline طبيعي كما في فوتوشوب)، levels، brightnessContrast، exposure، hueSaturation (الإضاءة بطريقة فوتوشوب لكل قناة)، vibrance، colorBalance، blackWhite، photoFilter، gradientMap، invert، posterize (تعريف فوتوشوب)، threshold. طبقة الضبط تعيد تلوين ما تحتها، أو قاعدتها فقط إذا كانت مقصوصة.
- `filter.add/update/remove/move` و`filter.mask {from:'selection'|'none'}`: مكدس فلاتر ذكية على الطبقة (gaussianBlur، motionBlur، radialBlur، unsharpMask، sharpen، highPass، addNoise، pixelate، adjustment) يبقى قابلًا للتعديل، ويُطبَّق قبل الأقنعة والمؤثرات.
- `smart.replace {assetId, newAssetId | dataUrl}`: استبدال صورة مضمّنة أينما استُخدمت مع بقاء التحويل والأقنعة والفلاتر والمؤثرات.
- مطابقة فوتوشوب (تسطيح فوتوشوب نفسه لملف PSD من ArtForge مقابل عرض ArtForge): curves 0، posterize 0، threshold 0، levels ≤2، hue/sat ≤1 (التشبع ≤6 على لون داكن واحد)، brightness/contrast ≤1.

## Blend If (P8)

- `layer.update {blendIf: {channel?: gray|red|green|blue, this?: [b0,b1,w1,w0], underlying?: [b0,b1,w1,w0]}}`، و`blendIf: null` يزيله. الطبقة تظهر فقط حيث تقع قيمتها وقيمة ما تحتها داخل النطاقين؛ القيم المنفصلة (b0<b1 أو w1<w0) تعطي انتقالًا ناعمًا. للطبقات فقط، ويحتاج v2.

## تنسيقات النص المتعددة داخل الفقرة

- `text.runs: [{start, end, font?: {family?, size?, weight?, style?}, fill?, underline?}]` (إزاحات UTF-16، `end` غير شامل، دون تداخل). `lineHeight` و`letterSpacing` للنص كله.
- `text.style {objectId, start?, end?, style: {font?, fill?, underline?} | clear: true}` يدمج التنسيق في النطاق ويقسم/يوحّد المقاطع تلقائيًا.
- الالتفاف يقيس كل جزء بخطه؛ الأجزاء تُرتَّب بصريًا (اتجاه ثنائي) على خط أساس مشترك؛ إذا وقع حد التنسيق داخل كلمة عربية يُضاف ZWJ على الجانبين فتبقى الحروف متصلة.
- تعديل النص بـ `object.update` دون `runs` جديدة يقصّ المقاطع على الطول الجديد.
- SVG: المقاطع `<tspan>` قابلة للتحرير. PSD: النص بكسلات (معلن في التقرير).
- إصلاح جذري مرافق: الأوزان غير المثبتة (800/900) للخطوط المرفقة كانت تُرسم مربعات فارغة في Node؛ الآن تُطابق أقرب وزن مثبت بقاعدة CSS.

## PSD بحدود معلنة (P7)

- التصدير يحفظ: ترتيب الطبقات، طبقات البكسل (RLE)، المجموعات، الأسماء بيونيكود (العربية سليمة)، الشفافية، أوضاع المزج، الظهور، القص، الخلفية كطبقة، الصورة المدمجة، ملف ICC، وطبقات ضبط أصلية (invert، posterize، threshold، brightnessContrast، levels، curves، hueSaturation).
- ما يُخبز في البكسلات ويُذكر في `report`: النص، المؤثرات، الفلاتر الذكية، الأقنعة، شفافية التعبئة. ما يظهر في الصورة المدمجة فقط: طبقات الضبط الأخرى، مؤثرات المجموعات، Blend If، مؤثرات اللوحة.
- الاستيراد: RGB 8-bit فقط (PSD لا PSB، حتى 8192px)، ضغط raw/RLE/ZIP؛ البكسلات، المجموعات، أقنعة الطبقات، القص، الشفافية، المزج، طبقات الضبط السبع أعلاه، وملف ICC (يُتعرف عليه بالمرجعيات اللونية). ما سواه (نص، كائن ذكي، مؤثرات، ضبط غير مدعوم) يُستورد بكسلات أو يُتخطى مع ذكره في `report`.
- التحقق: Photoshop 24 يفتح ملفات ArtForge ويقرأ الأسماء العربية والمجموعات والقص والمزج ونوعي CURVES/HUESATURATION وملف sRGB؛ وملف أنشأه Photoshop بقناع مموّه ومجموعة وقص وطبقة عكس يُستورد ببنيته كاملة وفرق متوسط < 0.5 مقابل تسطيح فوتوشوب.

## واجهة المحرر (P5–P8)

- أدوات البكسل في الشريط: فرشاة (B)، ممحاة (E)، معالجة البقع (J)؛ `[` و`]` للحجم، واللون من حقل «تعبئة». زر ▦+ في لوحة الطبقات ينشئ طبقة بكسل.
- لوحة «الطبقة»: Blend If، وإعدادات الفرشاة، والتشويه الجاهز، والإمالة، و«رقعة من التحديد».
- لوحة «الضبط والفلاتر»: إضافة طبقة ضبط وتعديل قيمها (أو JSON)، وإضافة الفلاتر الذكية وتفعيلها وترتيبها وحذفها، وقناع الفلاتر من التحديد.
- لوحة «المؤثرات»: الساتان والمحيطات (Contours)، وتعمل على المجموعات.
- العرض الحي يحمّل مربعات البكسل من `/assets/tiles/`؛ مطابقته لعرض الخادم: فرق متوسط 0.4.

## أدوات المتجهات على نمط فيجما (2026-11-08)

| العملية | المدخلات | ملاحظات |
|---|---|---|
| `draw.shape` | `kind` (polygon، star، arc، spiral، rect)، `x`، `y`، `w`، `h`، ومعاملات النوع: `sides`، `points` + `ratio`، `start` + `sweep` + `ratio` (فطيرة/حلقة)، `turns` + `growth` (archimedean/logarithmic) + `direction`، `radius` (رقم أو 4 قيم) + `smoothing` (0..1، Squircle)، `cornerRadius` للمضلع والنجمة | يُحفظ مسارًا عاديًا معه `shape` (المعاملات)، فيُرسم ويُصدَّر (PNG/SVG/PDF/PSD) كأي مسار |
| `shape.update` | `objectId`، `params` | يعيد التوليد مع الإبقاء على الموضع والحجم الحاليين بعد التحريك أو التحجيم |
| `shape.convert` | `objectId` (rect أو ellipse)، `smoothing` / `radius` أو `start` / `sweep` / `ratio` | يحوّل المستطيل إلى زوايا ناعمة والدائرة إلى قوس، في مكانه وبالمعرّف نفسه |
| `vector.fill` | `x`، `y`، `fill`، `layerId?` | سطل الطلاء للمتجهات: يملأ المساحة الفارغة المحاطة بخطوط أو أشكال بمسار جديد تحتها. يرفض المساحة المفتوحة (`REGION_NOT_CLOSED`) والنقطة المرسومة (`NOT_EMPTY`) |

- تحرير نقاط شكل بارامتري (`path.*Anchor`) يحوّله إلى متجه حر، كما في فيجما.
- `draw.network`: شبكة متجهة. `points` (النقاط، والمقابض بعلامة `ctrl: true`)، و`edges` [{a, b, c1?, c2?}] يمكن أن تتفرع من أي نقطة، و`regions` [{path: [[edge, reversed]...], fill}]. التحريك والتحجيم والتدوير تعمل عليها كأي عنصر نقاط، وتُصدَّر SVG متجهات.
- `network.fill {objectId, x, y, fill}`: يلوّن المنطقة المغلقة من الشبكة التي تحتوي النقطة (اجتياز وجوه الرسم المستوي)، و`fill: null` يزيل التلوين.
- `GET /api/palettes`: مكتبة الألوان (74 لوحة مستخرجة من `Color_Scheme`) لمنتقي الألوان في الواجهة.
