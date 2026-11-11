# مهارة 19 — محرك القرار الفني Art Direction (ArtForge)

## الغرض
توحيد كل قرارات الصورة قبل الرسم في مكان واحد متسق: التكوين، المنظور، العمق، الإضاءة، الظلال، الألوان، الخامات. الناتج في `direction.art`، ولكل قرار سببه ومصدره من الكتب حين يوجد.

## القرارات
| القرار | ما يحدده | المصدر |
|---|---|---|
| التكوين | الشبكة (أثلاث/مركز/تماثل)، البطل، النقطة المستهدفة، المنطقة الهادئة | `composition-eye`، `focal-flagging` |
| المنظور | مسطح، نقطة واحدة (داخلي)، نقطتان (معماري)، جوي (طبيعي)، علوي؛ خط الأفق ونقاط التلاشي | زاوية النظر من الطلب |
| العمق | لكل مستوى: المزج نحو السماء، التباين، التشبع، الحجم | `atmospheric-perspective`، `warm-advance-cool-recede` |
| الإضاءة | المصدر الرئيسي ونوعه واتجاهه وارتفاعه وحرارته والإضاءة المالئة | `key-light`، `three-light-systems-sunlight`، `local-light-source`، `color-temperature` |
| الظلال | الاتجاه (عكس الضوء) والطول والحدة واللون وظلال التلامس | `hard-light-sharp-shadow`، `occlusion-shadows`، `cast-vs-form-shadow` |
| الألوان | الأدوار من المرجع، التناغم، مفتاح القيمة، الحرارة لكل مستوى، أثر المزاج | `limited-palette` |
| الخامات | خامة كل عنصر ولمعته وملمسه | `reflections`، `dry-brush-texture` |

## التعارضات
تُكتشف وتُحل علنًا في `direction.art.conflicts`: ليل + شمس، مزاج مبهج + إضاءة ليلية، تماثل + بطل جانبي، ضوء من نافذة غير موجودة.

## التجاوز من المستدعي
`artDirection: { composition: "thirds|center|symmetric", focal: "<entity id>", lightFrom: "left|right|top", perspective: "flat|one-point|two-point|three-point|aerial|top-down", shadows: "hard|soft|none", temperature: "warm|cool|neutral" }`. التجاوز يُسجَّل `source: "caller"`.

خيارات متقدمة (اختيارية، معطلة افتراضيًا):
- **كاميرا عالمية**: `perspective:"three-point"` أو `world:true` مع `cameraHeight` (0.1–100)، `cameraPitch` (‑1.3..1.3 راديان)، `cameraYaw` (±π)، `cameraFocal`. يُسقط الأثاث من إحداثيات ثلاثية الأبعاد عبر كاميرا واحدة (نقاط التلاشي الثلاث متقاربة هندسيًا)، ويحوّل `engine:"auto"` إلى `scene-graph`. الناتج في `direction.art.perspective` و`direction.graph.world` (التصادمات).
- **تشريح الشخصية**: `anatomy:"rig-v1"` لهيكل مفصلي (FK/IK) بدل الافتراضي `legacy`.
`artforge_capabilities` يعرض هذه الأعلام في `features.optIns`.

## التعليمات الإلزامية
1. قرار واحد لكل جانب؛ لا مصدري ضوء رئيسيين.
2. لا تبدأ الرسم اليدوي قبل قراءة `direction.art`؛ اتبع اتجاه الضوء وحرارته في كل إضافة: `lightAngle` في `draw.form`، و`canvas.globalLight` للمؤثرات الحية (المهارة 22) حتى تسقط ظلالها في الاتجاه نفسه.
3. التدريج اللوني بعد الرسم (طبقات `photoFilter`/`curves`/`gradientMap`) يجب أن يوافق `direction.art.color.temperature` ولا ينقضه.

## الحدود
قرارات قواعدية مفسرة، لا ذائقة نموذج؛ المراجعة البصرية النهائية مطلوبة.
