# مهارة 22 — الطبقات والمؤثرات والأقنعة والضبط والفلاتر (محرك الرسم)

## الغرض
أن يُبنى التشطيب الاحترافي (ظل، توهج، ذهب، قص، تدرج لوني، تصحيح ألوان، تمويه عمق) **غير إتلافي وقابلًا للتعديل**، بالأدوات نفسها التي يعرفها مستخدمو فوتوشوب، بدل رسم ظلال وتوهجات يدوية بأشكال إضافية.

## متى تُستخدم
بعد `artforge_create_design`، أو في مستند جديد، حين يطلب المستخدم مؤثرًا أو قناعًا أو تصحيح ألوان أو فلترًا، أو حين تحتاج عزل جزء من التصميم وتعديله دون إعادة رسمه. كل العمليات تُرسل عبر `artforge_tool_op` بدفعة واحدة `op:"batch"` (المهارة 24).

## قبل أي شيء
- المستندات الجديدة تعمل بتركيب `v2` افتراضيًا. المؤثرات و`fillOpacity` وBlend If والمجموعات تحتاجه؛ المستند القديم (`legacy`) يُرفض بـ `EFFECTS_REQUIRE_V2`، والحل `document.update {canvas:{compositing:"v2"}}`.
- اعرف المعرّفات أولًا: `layer.list` (الترتيب والآباء والأقفال) و`object.list` (الصناديق). لا تخمّن `layerId`.

## خريطة القرار: أي أداة لأي حاجة
| الحاجة | الأداة الصحيحة | لا تفعل |
|---|---|---|
| ظل تحت عنوان أو بطاقة | `effect.add {type:"dropShadow"}` على طبقته | نسخة سوداء مموّهة مزاحة |
| حد حول نص أو شكل | `effect.add {type:"stroke", position:"outside"}` | تكرار النص بخط أعرض |
| ذهب، كروم، زجاج، نيون، نقش، بروز | `effect.applyPreset {preset: gold\|chrome\|glass\|neon\|emboss\|extruded, color?}` ثم `effect.update` للضبط | تدرجات يدوية متعددة |
| ملمس فوق شكل فقط | طبقة فوقه `clipped:true` أو `effect.add {type:"patternOverlay"}` | قص يدوي بمسار |
| إخفاء جزء بتدرج ناعم | `mask.create` ثم `mask.paint {shape:{type:"gradient"}}` | ممحاة على البكسلات |
| تصحيح ألوان / مزاج / توحيد لوني | `adjustment.add` (curves، hueSaturation، photoFilter، gradientMap…) | تغيير لون كل عنصر |
| عمق مجال، نعومة الخلفية، حدة البطل | `filter.add` (gaussianBlur على الخلفية، unsharpMask على البطل) | `blur` على كل كائن |
| دمج نسيج مع الظلال فقط | `layer.update {blendIf:{underlying:[…]}}` | أقنعة مرسومة يدويًا |
| مؤثر واحد لعدة طبقات | `group.create {layerIds}` ثم `effect.add` على المجموعة | تكرار المؤثر على كل طبقة |

## الطبقات والمجموعات
- `layer.add {name, opacity?, blend?, fillOpacity?, clipped?, parentId?, index?}`، و`layer.update` لتغيير أي منها لاحقًا، و`layer.move`/`layer.duplicate`/`layer.delete`.
- **`opacity` مقابل `fillOpacity`**: الأولى تخفي الطبقة ومؤثراتها، والثانية تخفي المحتوى وتُبقي المؤثرات (حد أو توهج بلا تعبئة = نص مفرغ).
- **أوضاع المزج (26)**: `multiply` للظلال والتلوين فوق الأسطح، `screen` للضوء والتوهج، `overlay`/`soft-light` للنسيج والتباين، `color` لتلوين صورة رمادية، `luminosity` لنقل الإضاءة فقط.
- **المجموعة** `group.create {layerIds}`: الوضع الافتراضي pass-through (طبقات الضبط داخلها تؤثر على ما تحتها)؛ إعطاؤها `blend` أو `opacity` يعزلها. `group.ungroup` يفكّها مع بقاء الطبقات.
- **الأقفال**: `locks:{position, content, alpha}` أو `locked:true`. قفل `alpha` على طبقة بكسل يجعل أدوات البكسل ترسم فقط حيث توجد بكسلات (تلوين داخل الشكل دون الخروج عنه).

## المؤثرات الحية (11 نوعًا)
`effect.add {layerId, effect:{type, ...}}`. ترتيب الرسم ثابت كفوتوشوب: dropShadow ← outerGlow ← extrude ← المحتوى ← patternOverlay ← gradientOverlay ← colorOverlay ← satin ← innerGlow ← innerShadow ← bevel ← stroke. القيم الافتراضية الكاملة من `effect.list`.

| النوع | أهم المعاملات | استخدام احترافي |
|---|---|---|
| `dropShadow` | `distance`، `size`، `spread`، `opacity`، `angle`/`useGlobalLight` | ظل ناعم للبطاقات: distance 8–16، size 14–30، opacity 0.25–0.45 |
| `innerShadow` | `distance`، `size`، `choke` | حفر وتجويف وزر مضغوط |
| `outerGlow` / `innerGlow` | `size`، `spread`/`choke`، `color`، `source` (edge/center) | نيون، هالة ضوء، إبراز بطل ليلي |
| `stroke` | `size`، `position` (outside/inside/center)، `paint` (لون أو تدرج) | قراءة نص فوق صورة؛ حد أبيض 2–4px |
| `bevel` | `style`، `technique`، `depth`، `size`، `soften`، `altitude` | أزرار، معادن، حجر محفور |
| `colorOverlay` / `gradientOverlay` / `patternOverlay` | `color` / `gradient{type,angle,stops}` / `pattern{kind,…}` | توحيد أيقونات، تدرج على نص، ملمس |
| `satin` | `distance`، `size`، `angle`، `invert`، `contour` | لمعان حرير ومعدن مصقول |
| `extrude` | `depth`، `angle`، `shade` | عمق مزيف للحروف (ليس 3D) |

- **`contour`** (اختياري على الظلال والتوهج والبروز والساتان): `linear`، `gaussian`، `cone`، `coneInverted`، `cove`، `halfRound`، `ring`، `ringDouble`، `rollingSlope`، `sawtooth`، أو نقاط `[[in,out],…]` 0..255. `ring` مع bevel يعطي معدنًا لامعًا.
- **الضوء العام**: `canvas.globalLight {angle, altitude}` (افتراضي 120°/30°) تتبعه كل المؤثرات ذات `useGlobalLight`. **اضبطه على اتجاه الضوء في `direction.art.lighting`** حتى تتسق ظلال المؤثرات مع ظلال المشهد.
- المؤثرات على المجموعة تُحسب على ناتجها المركّب.

## الأقنعة والقص والتحديد
- `mask.create {layerId, kind:"raster", from:"reveal"|"hide"|"selection"}` أو `kind:"vector"` مع `shapes`. تصلح للمجموعات أيضًا.
- `mask.paint {layerId, value, shape}`: `value` 0 يخفي و1 يُظهر؛ `shape:{type}`: `brush`، `rect`، `ellipse`، `polygon`، `path`، `gradient` (`from`، `to`، `fromValue`، `toValue`)، `all`. و`feather` لتنعيم الحافة.
- `mask.update {invert, density, feather, enabled, linked}` غير إتلافي، و`mask.apply` إتلافي (اطلبه فقط عند الحاجة).
- **قناع القص**: `clipped:true` على الطبقة فوق القاعدة؛ تظهر فقط داخل ألفا القاعدة (قد تكون القاعدة مجموعة).
- **التحديد** `selection.set {mode: replace|add|subtract|intersect, shape:{type: rect|ellipse|polygon|path|all|layerAlpha|colorRange|magicWand}}` ثم `selection.modify {modify: invert|feather|grow|shrink|smooth, radius}`؛ ومنه `mask.create {from:"selection"}`. التحديد مؤقت ولا يُحفظ.

## الضبط غير الإتلافي (13 نوعًا)
`adjustment.add {adjustment:{kind, ...}, opacity?, blend?, clipped?, from?:"selection"}` يضيف طبقة ضبط تعيد تلوين ما تحتها؛ مع `clipped:true` تؤثر على قاعدتها فقط.

| الحاجة | الضبط | قيم بداية |
|---|---|---|
| تباين S ناعم | `curves {rgb:[[0,0],[64,52],[192,205],[255,255]]}` | spline طبيعي مطابق لفوتوشوب |
| نقطة أسود/أبيض | `levels` | |
| إضاءة عامة | `brightnessContrast {brightness, contrast}` (‑1..1)، `exposure` | |
| تشبع وتلوين | `hueSaturation {hue, saturation, lightness, colorize?}`، `vibrance` | تقليل التشبع 0.1–0.2 لتوحيد المشهد |
| حرارة المزاج | `photoFilter {color, density}`، `colorBalance {shadows, midtones, highlights}` | دافئ: `#ec8a00` بكثافة 0.2 |
| تدرج لوني سينمائي | `gradientMap {stops}` بشفافية الطبقة 0.2–0.4 و`blend:"soft-light"` | |
| رمادي / ملصقات | `blackWhite`، `posterize {levels}`، `threshold {level}`، `invert` | `blackWhite` مؤقتًا لفحص القيم (المهارة 09) |

## الفلاتر الذكية
`filter.add {layerId, filter:{type, ...}}` تبقى قابلة للتعديل (`filter.update`، `filter.move`، `filter.remove`)، و`filter.mask {from:"selection"|"none"}` يحصرها في منطقة.
الأنواع: `gaussianBlur {radius}`، `motionBlur {angle, distance}`، `radialBlur {amount, centerX, centerY, mode: spin|zoom}`، `unsharpMask {amount, radius, threshold}`، `sharpen`، `highPass {radius}`، `addNoise {amount, seed}`، `pixelate {cellSize}`، `adjustment` (ضبط داخل المكدس).
- العمق: gaussianBlur 2–6 على طبقة الخلفية، و unsharpMask خفيف على البطل (قاعدة `edge-control`).
- السرعة: motionBlur على طبقة نسخة خلف العنصر.
- الحبيبات: addNoise 0.03–0.06 على المشهد كاملًا يوحّد الأسطح الرقمية.

## Blend If
`layer.update {layerId, blendIf:{channel: gray|red|green|blue, this:[b0,b1,w1,w0], underlying:[b0,b1,w1,w0]}}`. مثال: نسيج يظهر على المناطق الداكنة فقط ← `underlying:[0,0,180,230]`. `blendIf:null` يزيله. للطبقات فقط (لا للمجموعات).

## تشطيب الصورة كاملة
`document.update {canvas:{effects:[{type: haze|grade|bloom|vignette|tint|grain|paper, …}]}}`. المشاهد المؤلفة تضبطها تلقائيًا؛ لا تكررها بطبقات ضبط تؤدي العمل نفسه.

## مثال مُختبر (دفعة واحدة)
```json
{ "op": "batch", "params": { "documentId": "doc_…", "atomic": true, "ops": [
  { "op": "effect.add", "params": { "layerId": "<title>", "effect": { "type": "dropShadow", "distance": 8, "size": 14, "opacity": 0.45 } } },
  { "op": "effect.add", "params": { "layerId": "<title>", "effect": { "type": "stroke", "size": 2, "position": "outside", "paint": "#ffffff" } } },
  { "op": "effect.applyPreset", "params": { "layerId": "<badge>", "preset": "gold" } },
  { "op": "mask.create", "params": { "layerId": "<art>", "kind": "raster", "from": "reveal" } },
  { "op": "mask.paint", "params": { "layerId": "<art>", "value": 0, "shape": { "type": "gradient", "from": {"x":0,"y":700}, "to": {"x":0,"y":800}, "fromValue": 1, "toValue": 0 } } },
  { "op": "adjustment.add", "params": { "adjustment": { "kind": "curves", "rgb": [[0,0],[64,52],[192,205],[255,255]] } } },
  { "op": "filter.add", "params": { "layerId": "<background>", "filter": { "type": "gaussianBlur", "radius": 3 } } }
] } }
```

## أخطاء شائعة
- مؤثرات قوية على كل الطبقات: المؤثر للبطل والنص المهم فقط، وإلا ضاع التسلسل البصري.
- ظل مؤثر باتجاه يخالف ضوء المشهد: اضبط `canvas.globalLight`.
- `mask.apply` أو `raster.rasterize` دون طلب: يفقد قابلية التعديل.
- طبقة ضبط في أعلى المكدس وهي مقصودة لعنصر واحد: استخدم `clipped:true`.

## التحقق
المعاينة المرجعة من الدفعة، ثم `qa.check` (التباين والنصوص). عند التصدير إلى SVG/PDF: الطبقة ذات المؤثر أو القناع تُصدَّر صورة مع تحذير؛ وإلى PSD: المؤثرات والفلاتر والأقنعة تُخبز في البكسلات ويذكرها `report` (المهارة 06).

## الحدود
المؤثرات تقارب سلوكي لفوتوشوب (حقل مسافة دقيق، تمويه غاوسي)، لا تطابق خوارزمية Adobe. مطابقة الضبط مع فوتوشوب مقيسة: curves وposterize وthreshold فرق 0، levels ≤2، hue/sat ≤1.
