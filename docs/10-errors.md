# 10) الأخطاء المحتملة وكيفية معالجتها

كل خطأ يعود بكود ثابت في `error.code` ورسالة توضيحية و`details` عند الحاجة.
عبر HTTP: رمز الحالة 400 للأخطاء المنطقية، 404 لعدم وجود المستند/العنصر/الملف، 403 لمحاولات الوصول لملفات خارج المسموح، 500 لخطأ داخلي غير متوقع.

## أخطاء المدخلات

| الكود | المعنى | المعالجة |
|---|---|---|
| `INVALID_NUMBER` | حقل رقمي غير صالح أو خارج الحدود | راجع `details.received` واضبط القيمة داخل الحدود المذكورة في الرسالة |
| `INVALID_COLOR` | لون غير مقبول | استخدم `#rgb/#rrggbb/#rrggbbaa` أو `rgb()/rgba()/hsl()/hsla()/transparent` |
| `INVALID_PAINT` | قيمة تعبئة/حدود ليست لونًا ولا تدرّجًا | مرّر نصًا أو كائن تدرّج |
| `INVALID_GRADIENT` | تدرّج ناقص (أقل من محطتين) أو `offset` خارج 0..1 | أضف محطتين على الأقل بترتيب مقبول |
| `INVALID_BLEND` | وضع دمج غير مدعوم | استخدم إحدى القيم المذكورة في `03-architecture.md` |
| `INVALID_DASH` | `dash` ليس مصفوفة أرقام | مثال: `[10, 6]` |
| `INVALID_FONT` | حجم/وزن/تباعد أسطر خارج الحدود | الحجم 1–2000، الوزن 100..900، lineHeight 0.5–5 |
| `INVALID_TEXT` | النص أطول من 20000 حرف | اختصر النص أو قسّمه إلى عناصر |
| `INVALID_ALIGN` | محاذاة غير معروفة | `left` أو `center` أو `right` |
| `INVALID_OBJECT` / `INVALID_OBJECT_TYPE` | عنصر ناقص أو نوع غير مدعوم | النوع يجب أن يكون أحد السبعة |
| `INVALID_POINTS` / `INVALID_PATH` / `INVALID_ARROW` / `INVALID_CAP` | بنية رسم غير صحيحة | راجع أمثلة `04-operations.md` |
| `INVALID_FIT` | `fit` غير صحيح للصور | `fill` أو `contain` أو `cover` |
| `INVALID_INDEX` | ترتيب/موضع خارج المدى | القيمة من 0 إلى عدد العناصر |
| `INVALID_SCALE` | مقياس غير صالح | للنقل: >0 وحتى 50؛ للتصدير: >0 وحتى 4 |
| `INVALID_PATCH` | `object.update` بدون `patch` | مرّر حقولًا داخل `patch` |

## أخطاء المستندات

| الكود | المعنى | المعالجة |
|---|---|---|
| `MISSING_DOCUMENT_ID` | لم يُمرَّر `documentId` | مرّر المعرّف العائد من `document.create` |
| `DOCUMENT_NOT_FOUND` | معرّف غير موجود | استدعِ `document.list` وتحقق من `details.known` |
| `DUPLICATE_DOCUMENT` | معرّف مكرر عند الإنشاء | لا تمرّر `id` مخصصًا إلا إذا كان فريدًا |
| `INVALID_DOCUMENT` / `INVALID_DESIGN_FILE` | ملف/كائن ليس تصميم ArtForge | تأكد من `schema:"artforge.document"` |
| `UNSUPPORTED_VERSION` | إصدار ملف أحدث من المدعوم | استخدم ملفًا أنشأته نسخة متوافقة (v1) |
| `FILE_NOT_FOUND` | مسار الفتح غير موجود | تحقق من المسار على القرص |
| `INVALID_PATH` | مسار غير صالح أو امتداد غير مسموح | الحفظ يجب أن ينتهي بـ`.json` أو `.artforge.json` |
| `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` | لا يوجد سجل | تحقق من `history.state` قبل الاستدعاء |

## أخطاء الطبقات والعناصر

| الكود | المعنى | المعالجة |
|---|---|---|
| `LAYER_NOT_FOUND` | طبقة غير موجودة | استخدم `layer.list` |
| `LAYER_LOCKED` | الطبقة مقفلة | `layer.update { locked:false }` أولًا |
| `LAST_LAYER` | محاولة حذف الطبقة الوحيدة | أضف طبقة قبل الحذف |
| `NO_LAYER` | مستند بلا طبقات (حالة غير طبيعية) | أضف طبقة |
| `INVALID_LAYER` | بيانات طبقة غير صحيحة | راجع `name/opacity/blend` |
| `OBJECT_NOT_FOUND` | عنصر غير موجود | استخدم `object.list` |
| `INVALID_OBJECT_IDS` | مصفوفة معرّفات فارغة | مرّر معرّفًا واحدًا على الأقل |

## أخطاء الصور

| الكود | المعنى | المعالجة |
|---|---|---|
| `INVALID_ASSET` | `assetId` مفقود | نفّذ `image.add` أولًا |
| `INVALID_ASSET_TYPE` | امتداد غير مدعوم | PNG / JPG / JPEG / WEBP فقط |
| `ASSET_NOT_FOUND` | أصل غير مسجل | `image.list` |
| `ASSET_FILE_MISSING` | السجل موجود والملف محذوف | أعد إضافة الصورة |
| `ASSET_TOO_LARGE` / `EMPTY_ASSET` | ملف أكبر من 25MB أو فارغ | صغّر الصورة |
| `INVALID_DATA_URL` | `dataUrl` غير base64 صحيح | تأكد من الصيغة `data:image/png;base64,...` |

## أخطاء التحريك والتصدير

| الكود | المعنى | المعالجة |
|---|---|---|
| `INVALID_ANIMATION` | مدة/إطار/خاصية/مفاتيح غير صحيحة | مدة > 0، fps 1–60، مفتاحان على الأقل |
| `ANIMATION_DISABLED` | تصدير إطارات بدون تحريك مفعّل | `animation.set { enabled:true }` |
| `TRACK_NOT_FOUND` | مسار غير موجود | `animation.info` |
| `INVALID_FPS` | fps خارج 1–60 | اضبط القيمة |
| `INVALID_FORMAT` | صيغة تصدير غير مدعومة | png / jpeg / webp |
| `INVALID_QUALITY` | جودة خارج (0,1] | مثال 0.9 |
| `EXPORT_TOO_LARGE` | الأبعاد الناتجة > 16384px | قلّل `scale` |

## أخطاء الخادم/HTTP

| الكود | المعنى | المعالجة |
|---|---|---|
| `UNKNOWN_OP` | اسم عملية غير موجود | راجع `details.available` أو `GET /api/ops` |
| `INVALID_JSON` | جسم الطلب ليس JSON صحيحًا | صحّح الترميز |
| `BODY_TOO_LARGE` | الجسم أكبر من 8MB | استخدم `image.add` بمسار ملف بدل data URL ضخم |
| `INVALID_BATCH` | `ops` ليست مصفوفة في `/api/batch` | أرسل `{ ops: [...] }` |
| `FORBIDDEN` | محاولة الوصول لملف خارج المسموح (path traversal) | استخدم المسارات المتاحة فقط |
| `NOT_FOUND` | مسار HTTP غير معروف | راجع جدول نقاط HTTP |
| `INTERNAL_ERROR` | خطأ غير متوقع | راجع `server.err.log` وأبلغ بالتفاصيل |

## حسن الممارسة

- اقرأ `error.message` أولًا — صيغته تذكر الحقل والقيمة المستقبَلة والحدود.
- عند العمل بدفعات استخدم `/api/batch` مع `stopOnError: true` لتعرف أول خطوة فاشلة بدقة.
- أي عملية تفشل لا تُعدّل المستند (التحقق يسبق التعديل)، فلا حاجة إلى تراجع.
