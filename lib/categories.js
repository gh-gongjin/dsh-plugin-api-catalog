/**
 * lib/categories.js —— 分类名的中文标签映射（界面显示层，**不是**上游文字的一部分）。
 *
 * 口径（2026-10-05 用户裁定「中文 + 原文小字并列」）：
 * - 上游的 `## Animals` 这类章节名是分类的**身份**：主键、库里的 `category` 字段、导出 JSON 全都用它，一个字都不改。
 * - 中文名是本插件给的标签，只活在显示层，所以必须与原文**并列**出现，让人看得出这是两套名字（侧栏小字 + 悬停 title）。
 * - 上游改出没有映射的新分类 ⇒ `categoryLabel()` 回空串，界面回落成只显原文。**不许猜译、不许机翻兜底**：
 *   猜错的方向是「用户以为那是上游写的」。
 *
 * 键必须与 `meta.counts[].name` 逐字一致（含 `&` 两侧空格）；对不上的键由用例扫出来。
 */

export const CATEGORY_ZH = {
  'Animals': '动物',
  'Anime': '动漫',
  'Anti-Malware': '反恶意软件',
  'Art & Design': '艺术与设计',
  'Authentication & Authorization': '认证与授权',
  'Blockchain': '区块链',
  'Books': '图书',
  'Business': '商业',
  'Calendar': '日历',
  'Cloud Storage & File Sharing': '云存储与文件分享',
  'Continuous Integration': '持续集成',
  'Cryptocurrency': '加密货币',
  'Currency Exchange': '汇率兑换',
  'Data Validation': '数据校验',
  'Development': '开发',
  'Dictionaries': '词典',
  'Documents & Productivity': '文档与生产力',
  'Email': '邮件',
  'Entertainment': '娱乐',
  'Environment': '环境',
  'Events': '活动',
  'Finance': '金融',
  'Food & Drink': '餐饮',
  'Games & Comics': '游戏与漫画',
  'Geocoding': '地理编码',
  'Government': '政务',
  'Health': '健康',
  'Jobs': '招聘',
  'Machine Learning': '机器学习',
  'Music': '音乐',
  'News': '新闻',
  'Open Data': '开放数据',
  'Open Source Projects': '开源项目',
  'Patent': '专利',
  'Personality': '性格测试',
  'Phone': '电话',
  'Photography': '摄影',
  'Programming': '编程',
  'Science & Math': '科学与数学',
  'Security': '安全',
  'Shopping': '购物',
  'Social': '社交',
  'Sports & Fitness': '运动健身',
  'Test Data': '测试数据',
  'Text Analysis': '文本分析',
  'Tracking': '物流追踪',
  'Transportation': '交通出行',
  'URL Shorteners': '短链接',
  'Vehicle': '车辆',
  'Video': '视频',
  'Weather': '天气',
};

/** 查不到就回空串（不是回原文）：界面据此决定要不要那行小字，调用方不必自己判重。 */
export function categoryLabel(name) {
  const key = String(name ?? '').trim();
  return CATEGORY_ZH[key] || '';
}
