# مهارات تشغيل ArtForge للوكلاء

تعليمات عملية ملزمة لأي وكيل (Claude Code وChatGPT وCodex وCline) يستخدم ArtForge AI MCP، ولا تفترض معرفة سابقة بالأداة.

## كيف يجدها الوكيل
1. رسالة `initialize` في MCP توجّه إلى `artforge_tool_docs {guide:"operating-procedure"}` (المهارة 00: الأدوات، خريطة المهارات والمراجع، الإجراء).
2. `artforge_tool_docs {route:"<كلمات المستخدم>"}` يختار المهارات التي تحتاجها المهمة فقط (حتى 5، مرتبة بالمرحلة، ضمن ميزانية 9000 رمز افتراضيًا) مع سبب كل اختيار واستبعاد (المهارة 17).
3. `artforge_tool_docs {guide:"<id>"}` يقرأ مهارة، و`guide:"list"` يعرض عقود المهارات كلها: العنوان، المجموعة، المرحلة، المحفزات، الاعتماديات، التعارض، بصمة SHA-256 للملف، والقواعد المقتبسة من الكتب.
4. `artforge_tool_docs {query:"…"}` لمعاملات عملية بعينها (132 عملية موثقة).

الإجراء الإلزامي + 24 مهارة: 7 أساسية، 7 فنون عامة، 7 للمحرك الداخلي، و3 لأدوات محرك الرسم. لا يغطي موضوعٌ مهارتين (يُفحص في `tests/direction.test.js`)، والسجل في `src/engine/skill-registry.js`.

| id | الملف | المجموعة | يغطي |
|---|---|---|---|
| `operating-procedure` | `00-operating-procedure.md` | الإجراء | الأدوات، خريطة المهارات والمراجع، أقصر مسار — **ابدأ بها دائمًا** |
| `arabic-typography` | `01-arabic-typography.md` | أساسية | الطباعة العربية، تنسيق أجزاء النص، الأرقام، الورق المسطر |
| `tables` | `02-tables.md` | أساسية | الجداول |
| `color-light-shadow` | `03-color-light-shadow.md` | أساسية | اللوحة، أنظمة الإضاءة، المزج، ملفات الألوان |
| `drawing` | `04-drawing-brushes-perspective.md` | أساسية | الفرش، الخطوط العضوية، الأشكال البارامترية، المسارات والعمليات المنطقية، الشبكات المتجهة، السطل، المنظور |
| `references` | `05-references-and-knowledge.md` | أساسية | اللوحات والكتب والقواعد الخمس والعشرون والدليل |
| `quality-delivery` | `06-quality-and-delivery.md` | أساسية | الفحص، التصدير (PNG/JPEG/WebP/SVG/PDF/PSD/bundle)، ICC، التسليم |
| `model-drawing` | `07-model-drawing.md` | أساسية | SceneSpec يدوي من النموذج |
| `composition` | `08-composition.md` | فنون | البطل، الأثلاث، التوازن، المساحة السالبة |
| `value-and-form` | `09-value-and-form.md` | فنون | القيم، ظل الشكل وظل السقوط، الحواف |
| `figure-and-gesture` | `10-figure-and-gesture.md` | فنون | الإيماءة، مركز الثقل، النسب |
| `depth-and-space` | `11-depth-and-space.md` | فنون | إشارات العمق الخمس، الأفق وزاوية النظر |
| `materials-and-texture` | `12-materials-and-texture.md` | فنون | الخشب، القماش، الزجاج، الماء، الحجر، المعدن |
| `nature-elements` | `13-nature-elements.md` | فنون | السماء، الماء، الأشجار، الجبال |
| `mood-and-style` | `14-mood-and-style.md` | فنون | المزاج إلى القيمة واللون والإضاءة، وحدة الأسلوب، التدريج اللوني |
| `request-understanding` | `15-request-understanding.md` | محرك | الكيانات والأعداد والعلاقات والنفي والقيود |
| `scene-graph` | `16-scene-graph.md` | محرك | مخطط المشهد وحل العلاقات والاختيار الآلي للمحرك |
| `skill-routing` | `17-skill-routing.md` | محرك | اختيار المهارات وترتيبها وميزانيتها |
| `visual-references` | `18-visual-references.md` | محرك | تحويل اللوحات والأدلة وصور المستخدم إلى قواعد |
| `art-direction` | `19-art-direction.md` | محرك | القرار الفني الموحد قبل الرسم |
| `scenespec-engine` | `20-scenespec-engine.md` | محرك | توليد SceneSpec وفحص اكتماله |
| `visual-review` | `21-visual-review.md` | محرك | القياس بعد الرسم والتصحيح وإعادة التحقق |
| `layers-and-effects` | `22-layers-and-effects.md` | أدوات | الطبقات والمجموعات، المؤثرات الحية، الأقنعة والقص، طبقات الضبط، الفلاتر الذكية، Blend If |
| `pixels-and-retouch` | `23-pixels-and-retouch.md` | أدوات | طبقات البكسل، أدوات الفرشاة والرتوش، التحديد، التشويه والمنظور |
| `editing-workflow` | `24-editing-workflow.md` | أدوات | قراءة المستند، الدفعة الذرية، الترتيب والمحاذاة والتحويل، التراجع، المحرر المرئي |
| `promotional-layouts` | `25-promotional-layouts.md` | تكوين متخصص | البطاقات والإعلانات والبوسترات والبنرات |
| `logo-identity` | `26-logo-identity.md` | تكوين متخصص | الشعارات والهوية والاختبار بالحجم الصغير |
| `editorial-layouts` | `27-editorial-layouts.md` | تكوين متخصص | المجلات والأغلفة والهرمية التحريرية |
| `educational-layouts` | `28-educational-layouts.md` | تكوين متخصص | قوالب الدروس والإنفوجرافيك |
| `vector-colour-blending` | `29-vector-colour-blending.md` | أدوات | التدرج والمزج المتجه بأساليب Illustrator |
| `ornamental-composition` | `30-ornamental-composition.md` | تكوين متخصص | الزخرفة: مسار العين، مفردات المنحنى C/S/J، هرمية الوزن، كثافة التفاصيل، دراسة القيمة بلون واحد قبل التلوين، وكاشف المروحة |

القواعد الفنية المأخوذة من الكتب (25 قاعدة، كل منها مُثبتة باقتباس من صفحتها) وربطها بالمهارات: `book-index/markdown/RULES.md` (يُولَّد بـ `node tools/rules-catalog.js --check`).

كل الأمثلة الواردة في مهارات الأدوات (04، 22، 23، 24، 06) نُفذت فعليًا على المحرك قبل كتابتها.
