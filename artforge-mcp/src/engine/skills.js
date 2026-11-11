'use strict';

/**
 * Skill catalogue: each skill is a design intent with a canvas size, a layout recipe
 * and the tool operations the pipeline uses. Nothing here copies reference content;
 * it only decides structure (proportions, spacing, typography scale).
 */

const SKILLS = [
  {
    id: 'poster',
    name: 'ملصق / بوستر',
    nameEn: 'Poster',
    canvas: { width: 1200, height: 1600 },
    keywords: ['ملصق', 'بوستر', 'poster', 'إعلان', 'اعلان', 'flyer', 'إعلاني', 'دعائي', 'billboard'],
    bestFor: 'إعلان مطبوع أو رقمي رأسي بمساحة نص كبيرة',
    typography: { headlineRatio: 0.085, bodyRatio: 0.028, kickerRatio: 0.019 },
    layout: {
      marginRatio: 0.075,
      card: { enabled: true, yRatio: 0.13, heightRatio: 0.56, radius: 36, overlay: 0.55, stroke: 'rgba(226,232,240,0.16)' },
      headline: { yRatio: 0.21, maxWidthRatio: 0.86 },
      body: { yRatio: 0.43, maxWidthRatio: 0.62, lines: 2 },
      kicker: { yRatio: 0.63 },
      accentLine: { yRatio: 0.67, widthRatio: 0.22, thickness: 5, arrow: true },
      circles: { count: 5, yRatio: 0.80, sizeRatio: 0.085 },
    },
  },
  {
    id: 'social-square',
    name: 'منشور مربع',
    nameEn: 'Square social post',
    canvas: { width: 1080, height: 1080 },
    keywords: ['منشور', 'انستقرام', 'انستجرام', 'instagram', 'مربع', 'social', 'تواصل'],
    bestFor: 'منشورات شبكات التواصل المربعة',
    typography: { headlineRatio: 0.095, bodyRatio: 0.030, kickerRatio: 0.021 },
    layout: {
      marginRatio: 0.08,
      card: { enabled: true, yRatio: 0.12, heightRatio: 0.52, radius: 32, overlay: 0.5, stroke: 'rgba(226,232,240,0.14)' },
      headline: { yRatio: 0.2, maxWidthRatio: 0.84 },
      body: { yRatio: 0.42, maxWidthRatio: 0.6, lines: 2 },
      kicker: { yRatio: 0.6 },
      accentLine: { yRatio: 0.64, widthRatio: 0.24, thickness: 5, arrow: true },
      circles: { count: 4, yRatio: 0.8, sizeRatio: 0.09 },
    },
  },
  {
    id: 'story',
    name: 'ستوري رأسي',
    nameEn: 'Vertical story',
    canvas: { width: 1080, height: 1920 },
    keywords: ['ستوري', 'story', 'ستوريز', 'تيك توك', 'tiktok', 'reels', 'ريلز'],
    bestFor: 'قصص ومقاطع رأسية 9:16',
    typography: { headlineRatio: 0.088, bodyRatio: 0.028, kickerRatio: 0.02 },
    layout: {
      marginRatio: 0.075,
      card: { enabled: true, yRatio: 0.16, heightRatio: 0.5, radius: 40, overlay: 0.5, stroke: 'rgba(226,232,240,0.14)' },
      headline: { yRatio: 0.24, maxWidthRatio: 0.84 },
      body: { yRatio: 0.44, maxWidthRatio: 0.61, lines: 2 },
      kicker: { yRatio: 0.63 },
      accentLine: { yRatio: 0.67, widthRatio: 0.24, thickness: 6, arrow: true },
      circles: { count: 3, yRatio: 0.84, sizeRatio: 0.1 },
    },
  },
  {
    id: 'banner',
    name: 'بانر أفقي',
    nameEn: 'Horizontal banner',
    canvas: { width: 1600, height: 600 },
    keywords: ['بانر', 'banner', 'غلاف', 'header', 'لينكدإن', 'linkedin', 'أفقي', 'رأس صفحة'],
    bestFor: 'أغلفة صفحات ورؤوس مواقع',
    typography: { headlineRatio: 0.062, bodyRatio: 0.022, kickerRatio: 0.016 },
    layout: {
      marginRatio: 0.06,
      card: { enabled: false, yRatio: 0, heightRatio: 0, radius: 0, overlay: 0, stroke: null },
      headline: { yRatio: 0.3, maxWidthRatio: 0.6 },
      body: { yRatio: 0.5, maxWidthRatio: 0.5, lines: 2 },
      kicker: { yRatio: 0.24 },
      accentLine: { yRatio: 0.68, widthRatio: 0.2, thickness: 4, arrow: true },
      circles: { count: 4, yRatio: 0.72, sizeRatio: 0.11 },
    },
  },
  {
    id: 'card',
    name: 'بطاقة / واجهة',
    nameEn: 'Card / UI panel',
    canvas: { width: 1200, height: 800 },
    keywords: ['بطاقة', 'card', 'واجهة', 'ui', 'لوحة', 'panel', 'نافذة'],
    bestFor: 'بطاقات واجهات المستخدم',
    typography: { headlineRatio: 0.05, bodyRatio: 0.019, kickerRatio: 0.014 },
    layout: {
      marginRatio: 0.07,
      card: { enabled: true, yRatio: 0.14, heightRatio: 0.62, radius: 28, overlay: 0.6, stroke: 'rgba(226,232,240,0.18)' },
      headline: { yRatio: 0.22, maxWidthRatio: 0.8 },
      body: { yRatio: 0.42, maxWidthRatio: 0.62, lines: 3 },
      kicker: { yRatio: 0.66 },
      accentLine: { yRatio: 0.7, widthRatio: 0.18, thickness: 4, arrow: false },
      circles: { count: 3, yRatio: 0.78, sizeRatio: 0.07 },
    },
  },
  {
    id: 'cover',
    name: 'غلاف / صورة مصغّرة',
    nameEn: 'Cover / thumbnail',
    canvas: { width: 1600, height: 900 },
    keywords: ['غلاف', 'cover', 'مصغرة', 'thumbnail', 'يوتيوب', 'youtube'],
    bestFor: 'أغلفة الفيديو والصور المصغّرة',
    typography: { headlineRatio: 0.075, bodyRatio: 0.024, kickerRatio: 0.017 },
    layout: {
      marginRatio: 0.065,
      card: { enabled: true, yRatio: 0.16, heightRatio: 0.5, radius: 30, overlay: 0.45, stroke: 'rgba(226,232,240,0.14)' },
      headline: { yRatio: 0.24, maxWidthRatio: 0.8 },
      body: { yRatio: 0.46, maxWidthRatio: 0.55, lines: 2 },
      kicker: { yRatio: 0.66 },
      accentLine: { yRatio: 0.7, widthRatio: 0.22, thickness: 5, arrow: true },
      circles: { count: 4, yRatio: 0.78, sizeRatio: 0.09 },
    },
  },
  {
    id: 'invitation',
    name: 'دعوة مربعة',
    nameEn: 'Square invitation',
    canvas: { width: 1200, height: 1200 },
    keywords: ['دعوة', 'invitation', 'مناسبة', 'عيد', 'زفاف', 'حفل', 'تهنئة'],
    bestFor: 'بطاقات دعوة وتهنئة متناظرة',
    typography: { headlineRatio: 0.082, bodyRatio: 0.026, kickerRatio: 0.019 },
    layout: {
      marginRatio: 0.09,
      card: { enabled: true, yRatio: 0.18, heightRatio: 0.56, radius: 24, overlay: 0.55, stroke: 'rgba(226,232,240,0.2)' },
      headline: { yRatio: 0.3, maxWidthRatio: 0.78 },
      body: { yRatio: 0.48, maxWidthRatio: 0.56, lines: 2 },
      kicker: { yRatio: 0.64 },
      accentLine: { yRatio: 0.68, widthRatio: 0.3, thickness: 3, arrow: false },
      circles: { count: 2, yRatio: 0.78, sizeRatio: 0.07 },
    },
  },
];

const DEFAULT_SKILL = 'social-square';

function listSkills() {
  return SKILLS.map((skill) => ({
    id: skill.id,
    name: skill.name,
    nameEn: skill.nameEn,
    canvas: skill.canvas,
    keywords: skill.keywords,
    bestFor: skill.bestFor,
  }));
}

function getSkill(id) {
  if (!id) return SKILLS.find((skill) => skill.id === DEFAULT_SKILL);
  return SKILLS.find((skill) => skill.id === id) || null;
}

/** Score every skill against the free-form request text. */
function matchSkills(prompt) {
  const text = String(prompt || '').toLowerCase();
  return SKILLS.map((skill) => {
    let score = 0;
    const hits = [];
    for (const keyword of skill.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        score += keyword.length > 4 ? 2 : 1;
        hits.push(keyword);
      }
    }
    return { skill, score, hits };
  }).sort((a, b) => b.score - a.score);
}

module.exports = {
  SKILLS,
  DEFAULT_SKILL,
  listSkills,
  getSkill,
  matchSkills,
};
