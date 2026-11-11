# مهارة 23 — البكسلات والتحديد والرتوش والتشويه (محرك الرسم)

## الغرض
العمل على الصور والرسم النقطي باحتراف: طبقات بكسل، فرش حقيقية، تحديد دقيق، إزالة العيوب، تفتيح وتغميق موضعي، وتشويه المنظور، مع إبقاء كل ما يمكن غير إتلافي.

## متى تُستخدم
صورة من المستخدم تحتاج رتوشًا أو دمجًا، أو رسم يدوي بفرشاة بكسل، أو ملصق يحتاج ثني صورة أو وضعها على سطح بمنظور، أو ملف PSD مستورد. عبر `artforge_tool_op` بدفعة واحدة (المهارة 24).

## المبدأ: متجه أولًا، بكسل عند الحاجة
| الحاجة | الأفضل |
|---|---|
| أشكال ونصوص وأيقونات | متجهات (المهارة 04): تبقى قابلة للتعديل وتُصدَّر SVG/PDF |
| ملمس فرشاة يُعدَّل لاحقًا | `draw.brush` (طوابع متجهة) أو `draw.stroke` |
| رتوش صورة، استنساخ، تفتيح/تغميق موضعي، تلطيخ | طبقة بكسل + `raster.paint` |
| تشويه صورة على سطح | `raster.transform` |
لا تستخدم `raster.rasterize` (إتلافي) إلا إذا احتجت أداة بكسل على نص أو شكل موجود، وأخبر المستخدم.

## طبقات البكسل
- `raster.create {name, fill?, parentId?, index?}` ← `layerId`. البكسلات مربعات 256×256 مخزنة بتجزئتها، فالطبقة الكبيرة الفارغة رخيصة.
- الصورة: `image.add {path | dataUrl}` ثم `draw.image {assetId, x, y, w, h, fit: cover|contain|fill}`؛ استبدالها لاحقًا بكل تحويلاتها ومؤثراتها: `smart.replace {assetId, newAssetId | dataUrl}`.
- لنسخ صورة إلى بكسلات قابلة للرتوش: ضعها في طبقة ثم `raster.rasterize {layerId}`.
- ملف فوتوشوب: `document.importPsd {path}` (RGB 8‑bit)، ثم اقرأ `report` لمعرفة ما استُورد بكسلات أو تُخطّي.

## أدوات `raster.paint`
`raster.paint {layerId, tool, points:[{x,y,p?}], size, hardness, opacity, flow, color?}`. الضغط `p` (0..1) يتحكم بالحجم/الشفافية (`pressureSize`، `pressureOpacity`). يحترم التحديد وقفل الشفافية.

| `tool` | الاستخدام | معاملات خاصة |
|---|---|---|
| `brush` | رسم وتلوين | `color` |
| `eraser` | محو (فضّل القناع إن أمكن) | |
| `clone` | نسخ منطقة إلى أخرى | `source {x, y}` |
| `heal` | استنساخ مع مطابقة الإضاءة والملمس | `source {x, y}` |
| `dodge` / `burn` | تفتيح/تغميق موضعي (نحت الضوء) | `range: shadows\|midtones\|highlights`، `exposure` 0.1–0.5 |
| `sponge` | رفع/خفض التشبع موضعيًا | `mode: saturate\|desaturate` |
| `smudge` / `blur` / `sharpen` | سحب اللون، تنعيم، شحذ موضعي | `strength` |

قواعد احترافية: dodge/burn بتعريض منخفض (0.1–0.3) وتمريرات متعددة، `range:"midtones"` للبشرة والأقمشة، و`highlights` للمعادن. hardness منخفضة (0.2–0.4) للرتوش، عالية للحواف.

## الرتوش وإزالة العيوب
| المشكلة | الأداة |
|---|---|
| بقع صغيرة متفرقة | `raster.spotHeal {layerId, points:[{x,y}], size}` — المصدر يُختار تلقائيًا من الجوار ويُدمج بحل لابلاس |
| منطقة أكبر (كتابة، سلك، عنصر) | `selection.set` حولها ثم `raster.patch {layerId, offset:{x,y}}`؛ بدون `offset` يبحث عن مصدر نظيف، وإن لم يجد يرجع `NO_SOURCE` فمرّر الإزاحة |
| نمط متكرر أو حافة دقيقة | `raster.paint {tool:"clone", source}` |
| تعبئة بلون | `raster.fill {layerId, x, y, color, tolerance, contiguous}` (دلو البكسل) أو داخل التحديد |
| تدرج داخل منطقة | `raster.gradient {layerId, from, to, stops, type}` داخل التحديد |

## التحديد
`selection.set {mode, shape}`؛ `mode`: `replace`، `add`، `subtract`، `intersect`.
- أشكال: `rect`، `ellipse`، `polygon` (لاسو)، `path`، `all`.
- من البكسلات: `layerAlpha {layerId}` (شكل الطبقة)، `colorRange {color, fuzziness}`، `magicWand {x, y, tolerance, contiguous, layerId?}`.
- تعديل: `selection.modify {modify: invert|feather|grow|shrink|smooth, radius}`، ثم `selection.info` للتحقق من المساحة، و`selection.clear` عند الانتهاء.
- استخدامه: حصر الرسم والرتوش، أو `mask.create {from:"selection"}`، أو `filter.mask`، أو `adjustment.add {from:"selection"}`.

## التحويل والتشويه (`raster.transform`)
| الوضع | المدخلات | الاستخدام |
|---|---|---|
| `perspective` / `distort` | `corners` [4 نقاط: أعلى‑يسار، أعلى‑يمين، أسفل‑يمين، أسفل‑يسار] | وضع ملصق أو شاشة على سطح بمنظور |
| `skew` | `skewX`، `skewY` | ميل ظل أو نص |
| `warp` | `preset`: arc، arch، bulge، flag، wave، fisheye، rise، squeeze، twist + `bend` (‑1..1) | ثني شعار على كوب أو راية |
| `mesh` | `rows`، `cols`، `points` | تشكيل حر دقيق |
إتلافي على بكسلات الطبقة (كفوتوشوب على طبقة عادية)؛ احتفظ بنسخة `layer.duplicate` مخفية إن كان التعديل تجريبيًا. الأركان بإحداثيات المستند؛ اقرأ الصندوق من `object.list`/`layer.list` قبل الحساب.

## مثال مُختبر
```json
{ "op": "batch", "params": { "documentId": "doc_…", "ops": [
  { "op": "raster.create", "params": { "name": "retouch" } },
  { "op": "raster.paint", "params": { "layerId": "<retouch>", "tool": "brush", "points": [{"x":300,"y":650},{"x":500,"y":700,"p":0.6}], "size": 30, "hardness": 0.3, "color": "#7c3aed" } },
  { "op": "selection.set", "params": { "mode": "replace", "shape": { "type": "ellipse", "x": 380, "y": 640, "w": 80, "h": 80 } } },
  { "op": "selection.modify", "params": { "modify": "feather", "radius": 6 } },
  { "op": "raster.paint", "params": { "layerId": "<retouch>", "tool": "dodge", "points": [{"x":400,"y":680},{"x":440,"y":680}], "size": 40, "range": "midtones", "exposure": 0.4 } },
  { "op": "selection.clear", "params": {} },
  { "op": "raster.spotHeal", "params": { "layerId": "<retouch>", "points": [{"x":420,"y":680}], "size": 24 } },
  { "op": "raster.transform", "params": { "layerId": "<retouch>", "mode": "warp", "preset": "arc", "bend": 0.3 } }
] } }
```
(معرّف الطبقة الجديدة يرجع في `results[i].layerId`؛ إن احتجته داخل الدفعة نفسها فأنشئ الطبقة في دفعة أولى.)

## أخطاء شائعة
- الرتوش مباشرة على الصورة الأصلية: ضع الرتوش في طبقة بكسل فوقها حيث أمكن (clone/heal يأخذان العينة من الطبقة نفسها، فارسم على نسخة).
- نسيان `selection.clear`: كل أدوات البكسل اللاحقة تُحصر في التحديد القديم.
- `raster.transform` على طبقة أشكال: يحتاج طبقة بكسل.
- ممحاة بدل قناع: لا يمكن التراجع عن جزء منها لاحقًا.

## التحقق
المعاينة بعد الدفعة؛ `selection.info` قبل عمليات المنطقة؛ `history.state` و`history.undo`/`history.jump` للتراجع (الدفعة خطوة تراجع واحدة).

## الحدود
RGB بعمق 8 بت؛ لا ملء مدرك للمحتوى بنموذج توليدي (`spotHeal` و`patch` تعتمد على مصدر من الصورة نفسها)؛ لا CMYK.
