# مهارة 04 — الرسم المتجهي: الفرش والمسارات والأشكال والشبكات والمنظور

## الغرض
اختيار أداة الرسم الصحيحة لكل شكل حتى يكون الناتج نظيفًا وقابلًا للتعديل والتصدير متجهًا: فرش بملمس، وخطوط عضوية، وأجسام مظللة، وأشكال بارامترية، ومسارات بيزيه، وعمليات منطقية، وشبكات متجهة، وسطل طلاء.

## متى تُستخدم
إضافات يدوية بعد `artforge_create_design`، أو شعار وأيقونة ورسم توضيحي متجهي، أو بناء `sceneSpec` يدوي (المهارة 07 تحدد العمليات المسموحة داخله). المشاهد الكاملة تبقى لـ `create_design`: لا تبنِ غرفة أو منظرًا من عشرات المستطيلات.

## أنواع الرسم الجاهزة (`artforge_create_design`)
| النوع | ما يرسمه | المنظور |
|---|---|---|
| `scene` | غرفة: مكتبة، تلفاز، شخص جالس، كنبة/كرسي، مصباح، نافذة، نبتة، سجادة، لوحة جدار، ساعة، مكتب وأدوات | نقطة تلاشٍ واحدة على مستوى العين |
| `landscape` | سماء وشمس/قمر/نجوم/غيوم، جبال، تلال، بحر، نهر، بحيرة، أشجار، نخيل، كثبان، صخور، قارب، منارة، بيت وحديقة، طيور، زهور، عشب | منظور جوي بالطبقات |
| `architecture` | ساحة مدينة: برج زجاجي، أجنحة حجرية، أفق مدينة، أشجار شارع، مارّة، بلاط بمنظور | نقطتا تلاشٍ؛ أعين المارة على خط الأفق |
| `character` | شخصية واقفة مبسطة | 7.5 رؤوس، ووزن على قدم |
بيت أو حديقة وحدهما يُوجَّهان إلى `landscape`. الخامات المذكورة (حجر، طوب، خشب) تُرسم هندسيًا على البيت، وتُفحص (`material not drawn`). `style:"painterly"` يرسم الطبيعة بضربات فرشاة. العنصر غير المدعوم يظهر في `design.missing` ولا يُزيَّف.

## اختيار الأداة
| الشكل المطلوب | الأداة | لماذا |
|---|---|---|
| ضربة بملمس (عشب، غيوم، فحم، مائي) | `draw.brush` | طوابع إجرائية بمزج رطب |
| خط حبر/توقيع/شعر بسماكة متغيرة | `draw.stroke` | مسار مغلق واحد قابل للتعديل والتصدير SVG |
| جسم مظلل (صخرة، كرة، صندوق، ورقة) | `draw.form` | ظل + وجه مضاء + لمعة + ملمس في عملية واحدة |
| مضلع منتظم، نجمة، قوس/فطيرة/حلقة، حلزون، مستطيل ناعم الزوايا | `draw.shape` | بارامتري: يُعدَّل لاحقًا بـ `shape.update` |
| منحنى حر دقيق | `draw.path` (`M/L/Q/C/Z`) | تحكم كامل بالمقابض |
| رسم حر من نقاط | `draw.freehand` مع `smooth` 0–1 | منحنيات تمر بالنقاط |
| شكل مركب (هلال، قلب، ثقب، شعار) | `path.boolean` | قص ودمج دقيق مع حفظ المنحنيات |
| خطوط متفرعة ووجوه ملونة (خريطة، أيقونة مقطعة) | `draw.network` + `network.fill` | شبكة متجهة كفيجما |
| تلوين منطقة محاطة بخطوط | `vector.fill` | سطل طلاء متجهي |
| خلفية متدرجة | `draw.gradient` (linear/radial/conic) | تدرج OKLab بلا أشرطة |

## الفرش (`draw.brush`)
| الإعداد | الاستخدام |
|---|---|
| `round` / `soft` / `soft-edge` | خط نظيف / تظليل وتوهج / تلوين متساوٍ بحواف ناعمة |
| `flat` / `rough` | ضربة مسطحة بزاوية / فرشاة جافة بحواف متكسرة |
| `pencil` / `ink` / `charcoal` / `chalk` | اسكتش / حبر بالضغط / فحم / طباشير على ملمس الورق |
| `dotted` / `dashed` / `spaced` | نقاط / تقطيع / طوابع بفواصل (خرز، غرز) |
| `texture` / `spray` | تهشير وملمس / رذاذ (نجوم، غبار، زهور) |
| `smudge` / `oil` / `watercolor` / `marker` | مزج يلتقط اللون تحته / زيتي بشعيرات / غسلة شفافة بحافة صبغة / ماركر يتراكب |

`brush {preset, size, spacing, hardness, flow, angle, aspect, jitter, taper, seed}`، والمزج الرطب `wet` و`pickup` و`colorJitter` و`edge` و`grains`، والضغط `points[].p` (0–1)، و`smooth`، و`colors[]` على طول الضربة، و`symmetry {axis: vertical|horizontal|both, at}`، و`repeat {count, dx, dy}`. العشوائية مثبتة بـ `seed` (المعاينة والتصدير متطابقان). القائمة الكاملة: `brush.presets`.

```json
{ "op": "draw.brush", "params": { "points": [{"x":100,"y":400,"p":0.3},{"x":300,"y":320,"p":1},{"x":520,"y":380,"p":0.4}],
  "color": "#1d4ed8", "colors": ["#1d4ed8","#db2777"], "brush": {"preset":"ink","size":14,"seed":3}, "smooth": 0.7 } }
```

## الخط العضوي (`draw.stroke`)
`points[{x,y,p?}]`، `size` (8)، `thinning` (0.6)، `smoothing` (0.5)، `taperStart` (0.15)، `taperEnd` (0.2)، `color`، `curve` (true = منحنى Catmull-Rom كثيف عبر نقاط تحكم قليلة، جسم أملس متساوي العرض)، `outline {color, width}` (حدّ مطابق بالمحور نفسه يوضع تحت التعبئة، ويفعّل `curve`). يرجع `metrics {length, samples, maxWidth, minWidth}` و`outlineObjectId` عند وجود الحد.

للأجسام السميكة (ثعبان، نهر، شريط، ذيل): مرّر 5–15 نقطة تحكم مع `outline`، ولا ترسم ضربتين منفصلتين بعرضين مختلفين لتصنع حدًا: الضربتان لا تتبعان المحور نفسه فيظهر الحد متعرّجًا.

الأشكال ذات الحد فقط (`stroke` بلا `fill`) في `draw.rect`/`draw.ellipse`/`draw.polygon` إطارات شفافة الداخل (نظارات، حلقات، حدود شارات). الشكل بلا تعبئة ولا حد يبقى أسود كما كان. هو الخيار الصحيح للخطوط التي ستُصدَّر SVG/PDF؛ `draw.brush` يُصدَّر صورة لكل كائن.

## الجسم المظلل (`draw.form`)
`shape: rect|ellipse|polygon|path`، `fill`، `lightAngle` (خذه من `direction.art.lighting`)، `soft` (0–1)، `shade`، `highlight`، `texture {kind, opacity}`، `gloss`، `outline`. ينتج عناصر مسماة `name:shadow/lit/highlight/...`.

## الأشكال البارامترية (`draw.shape`)
| `kind` | المعاملات |
|---|---|
| `polygon` | `sides`، `cornerRadius` |
| `star` | `points`، `ratio` (نصف القطر الداخلي)، `cornerRadius` |
| `arc` | `start`، `sweep` (درجات)، `ratio` (0 فطيرة، >0 حلقة/دونات) |
| `spiral` | `turns`، `growth: archimedean|logarithmic`، `direction` (خط مفتوح: استخدم `stroke`) |
| `rect` | `radius` (رقم أو 4 قيم)، `smoothing` 0..1 (زوايا Squircle كأيقونات iOS) |
مع `x, y, w, h` و`fill`/`stroke`. التعديل لاحقًا: `shape.update {objectId, params:{points:6}}` يحفظ الموضع والحجم. `shape.convert` يحوّل مستطيلًا موجودًا إلى زوايا ناعمة أو دائرة إلى قوس في مكانها. تحرير نقاط الشكل البارامتري يحوّله إلى مسار حر.

## المسارات والعمليات المنطقية
- `path.boolean {objectIds, op: union|subtract|intersect|exclude, keepOriginals?}`: `subtract` = الأول ناقص البقية. المنحنيات تبقى منحنيات.
- `path.fromShape` يحوّل rect/ellipse/polygon إلى مسار؛ `path.outlineStroke` يحوّل الحد إلى شكل معبأ (قبل boolean على خط).
- تحرير النقاط: `path.anchors` (اقرأ أولًا)، `path.updateAnchor`، `path.addAnchor {t}`، `path.deleteAnchor`، `path.convertAnchor {type: corner|smooth}`.

## الشبكة المتجهة والسطل
- `draw.network {points, edges, regions?, stroke, strokeWidth}`: `points` رؤوس (والمقابض `ctrl:true`)، `edges [{a, b, c1?, c2?}]` تتفرع من أي رأس، `regions [{path:[[edge, reversed]…], fill}]`.
- `network.fill {objectId, x, y, fill}` يلوّن الوجه المغلق الذي يحتوي النقطة، و`fill:null` يزيله.
- `vector.fill {x, y, fill, layerId?}` يملأ المساحة الفارغة المحاطة بخطوط/أشكال بمسار جديد تحتها؛ يرفض المفتوحة (`REGION_NOT_CLOSED`) والمرسومة (`NOT_EMPTY`).

## التعبئة والتشطيب على مستوى الكائن
- التدرجات `linear|radial|conic` لأي `fill` مع `smooth:true`/`easing` (OKLab).
- الأنماط `fill:{type:"pattern", kind: hatch|crosshatch|dots|stripes|grain|paper|brick|tiles|wood|noise, color, scale, angle}`.
- `clip {type: rect|ellipse|path}`، و`blur` (0–200)، و`blend` (26 وضعًا)، و`shadow {color, blur, offsetX, offsetY}`، و`opacity` لكل كائن.
- للظلال والتوهج والحدود الاحترافية على طبقة كاملة استخدم المؤثرات الحية (المهارة 22) لا `shadow` لكل كائن.

## المنظور
- الأفق من زاوية النظر (المهارة 11)، وأعين الواقفين عليه.
- الأجسام البعيدة أصغر وأقرب للون السماء؛ القواعد الأبعد أعلى.
- `artDirection.perspective`: `flat`، `one-point`، `two-point`، `three-point`، `aerial`، `top-down`.
- صورة على سطح مائل: `raster.transform {mode:"perspective", corners}` (المهارة 23).

## التعليمات الإلزامية
1. شكل يُتوقع تعديله لاحقًا = أداة بارامترية أو مسار، لا مضلع ثابت ولا بكسلات.
2. الأشكال العضوية بالمنحنيات (`draw.path`، `draw.freehand` مع `smooth`، `draw.stroke`)، والملمس بالفرش.
3. كل الإضافات في دفعة واحدة (المهارة 24)، وتتبع اتجاه الضوء في الخطة.

## التحقق
`design.coverage` (كل عنصر وعملياته)، و`design.composition.perspective`، و`maxVanishingErrorPx` في المعماري (نحو 0)، والمعاينة المرجعة.

## الحدود
رسم توضيحي متجهي مظلل؛ فرش المزج الرطب محاكاة إجرائية. غير متاح: الواقعية الفوتوغرافية، الأنمي المتقن، نقل الأسلوب، والحروف ثلاثية الأبعاد بالخامات (`extrude` عمق مزيف فقط).
