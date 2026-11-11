# مهارة 24 — سير عمل التعديل بعد الإنشاء (محرك الرسم)

## الغرض
تعديل تصميم موجود بدقة وبأقل عدد من الاستدعاءات: اعرف ما في المستند، ثم أرسل كل التعديلات في دفعة واحدة آمنة، ثم تحقق من المعاينة المرجعة.

## متى تُستخدم
كل طلب «عدّل، حرّك، غيّر اللون، كبّر، حاذِ، احذف، أضف عنصرًا» على مستند أنشأه `artforge_create_design` أو فتحه المستخدم. لا تُعد إنشاء التصميم من الصفر لتعديل صغير.

## الدورة الإلزامية (3 استدعاءات كحد أقصى)
1. **اقرأ** (استدعاء واحد): `artforge_tool_op {op:"batch", params:{documentId, ops:[{op:"layer.list"},{op:"object.list"}]}}` يعطي الطبقات بترتيب الرسم والكائنات بصناديقها ومعرّفاتها. للتفاصيل الكاملة `document.info`.
2. **عدّل** (استدعاء واحد): كل التغييرات في `op:"batch"` مع `atomic:true`. `documentId` يُملأ في كل عملية تلقائيًا عبر `artforge_tool_op`.
3. **تحقق**: الرد يحمل المعاينة المحدثة؛ افحصها. التصدير فقط إذا طُلبت صيغة أو مقاس آخر (`artforge_export`).
جولتا تصحيح كحد أقصى، ثم أبلغ عن الحدود المتبقية.

## الدفعة الآمنة
- `atomic: true`: إن فشلت أي عملية يُتراجع عن الدفعة كلها (`rolledBack: true`)، فلا يبقى مستند نصف معدّل. الخطأ يذكر `batchIndex` والعملية.
- `expectedRevision` (أو `expectedRevisions` لعدة مستندات): ترفض الدفعة إن تغيّر المستند منذ قراءتك (المستخدم يعدّل في المحرر في الوقت نفسه).
- الدفعة خطوة تراجع واحدة: `history.undo` يلغيها كلها، و`history.jump {steps:-n}` لعدة خطوات.
- حتى 2000 عملية في الاستدعاء الواحد. لا ترسل عملية واحدة في كل استدعاء أبدًا (كل استدعاء عبر ChatGPT نحو 4 ثوانٍ).
- معرّف كائن أو طبقة تُنشئه الدفعة يرجع في `results[i]`؛ إذا احتاجته عملية لاحقة فاجعلها في دفعة ثانية، أو أعطِ العنصر `name` واقرأه بعد ذلك.

## أوامر الترتيب والتحويل
| الحاجة | العملية |
|---|---|
| تحريك/تحجيم/تدوير عدة كائنات معًا | `object.transform {objectIds, dx, dy, scale?, rotation?, pivot?}` — يحرك الهندسة الفعلية لكل نوع |
| موضع أو مقاس مطلق | `object.transform {objectId, x, y, width, height}` |
| محاذاة | `object.align {objectIds, align: left\|center\|right\|top\|middle\|bottom, relativeTo: canvas\|selection}` |
| توزيع متساوٍ (3 كائنات فأكثر) | `object.distribute {objectIds, axis: horizontal\|vertical, mode: gaps\|centers}` |
| لون/خط/نص/خصائص | `object.update {objectId, patch}` (يُعاد التحقق من الكائن كاملًا) |
| نقل بين الطبقات أو تغيير الترتيب | `object.move {objectId, targetLayerId?, index?}`، `layer.move` |
| نسخ | `object.duplicate {objectId, dx, dy}`، `layer.duplicate` |
| حذف | `object.delete`، `layer.delete` (تبقى طبقة واحدة على الأقل) |
| قص اللوحة أو تكبيرها | `document.crop {x, y, width, height}` غير إتلافي |
| أدلة | `guide.add/update/remove/clear` (لا تُصدَّر) |
| قياس قبل القرار | `object.measure {objectIds}`، `text.measure` |

## تعديل النص
- `object.update` على `text` لتغيير الكلمات (المقاطع المنسقة تُقصّ على الطول الجديد).
- تنسيق جزء من النص: `text.style {objectId, start, end, style:{font:{family,size,weight}, fill, underline}}` أو `clear:true`. الحروف العربية تبقى متصلة عبر حد التنسيق (المهارة 01).
- لا تحوّل النص إلى مسارات أو بكسلات إلا بطلب صريح.

## التعديل البصري الموجّه
- عنصر لا يظهر: `qa.visibility {groups:[{id, objectIds}]}` يقيس نسبة البكسلات التي تتغير بوجوده؛ الحل رفع طبقته (`layer.move`) أو فصل قيمته عن الخلفية لا زيادة حجمه.
- نص غير مقروء: `qa.check` ← `LOW_CONTRAST`؛ أضف `stroke` أو `dropShadow` (المهارة 22) أو تدرج قراءة خلفه.
- اتساق الضوء: أي إضافة يدوية تتبع `direction.art.lighting` من الخطة (الاتجاه والحرارة).

## مثال مُختبر
```json
{ "op": "batch", "params": { "documentId": "doc_…", "atomic": true, "ops": [
  { "op": "object.align", "params": { "objectIds": ["obj_a","obj_b","obj_c"], "align": "top", "relativeTo": "selection" } },
  { "op": "object.distribute", "params": { "objectIds": ["obj_a","obj_b","obj_c"], "axis": "horizontal", "mode": "gaps" } },
  { "op": "object.transform", "params": { "objectIds": ["obj_a","obj_b","obj_c"], "dx": 0, "dy": 10 } },
  { "op": "object.update", "params": { "objectId": "obj_title", "patch": { "fill": "#1e3a8a" } } }
] } }
```

## المحرر المرئي (عند عمل المستخدم بيده)
أدوات الشريط: تحديد V، نقاط A، مستطيل R، بيضاوي O، خط L، مضلع، نجمة، قوس، حلزون، قلم P، رصاص Shift+P، سطل المتجهات، نص T، صورة I، فرشاة بكسل B، ممحاة E، معالجة البقع J. بعد رسم أي شكل يعود المحرر إلى التحديد فيمكن تحريكه مباشرة. اللوحات: الطبقات، الطبقة (Blend If وفرشاة البكسل والتشويه)، المؤثرات، الضبط والفلاتر، الشكل، منتقي الألوان (74 لوحة مرجعية)، محرر التدرج متعدد النقاط، السجل. كل ما يفعله المستخدم في المحرر يمر بالعمليات نفسها، فاقرأ `document.info` قبل التعديل بعده.

## أخطاء شائعة
- تخمين المعرّفات أو أسماء الطبقات بدل قراءتها.
- إعادة `artforge_create_design` لتغيير لون واحد: تُفقد كل تعديلات المستخدم.
- `artforge_export` بعد كل دفعة: الدفعة ترجع المعاينة.
- تعديل طبقة مقفلة: يُرفض (`locks`)؛ أخبر المستخدم أو فك القفل بطلبه.

## الحدود
لا تحرير متزامن متعدد المستخدمين؛ `expectedRevision` يكشف التعارض ولا يدمجه.
