/* =============================================================================
 *  /p/<id>  —  分享用的房源链接（vercel.json 把它改写到这里）
 * =============================================================================
 *  为什么存在：房源的深层链接是 /#property/<id>，但 # 后面的部分不会送到服务器，
 *  WhatsApp / Facebook / Telegram 的爬虫抓到的永远是首页 —— 贴出去的预览就是
 *  一张通用卡，看不到这套房子的照片和价格。
 *
 *  这里回传一页带该房源 Open Graph 标签的 HTML 给爬虫读，
 *  真人打开则马上被导向 /#property/<id>，看到的还是原本的详情页。
 * ========================================================================== */

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://fryynuhukubqppilqpfk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_GnK_xyRsCtIO7vtE9k-zPw_eSs4Erd0';

const SITE = 'https://kareen-web.vercel.app';
const AGENT = 'Kareen Loke · REN 72111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 跟 index.html 的 parseSqftRange 同一套规则 */
function sqftRange(raw) {
  if (!raw) return null;
  const nums = String(raw).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const vals = nums.map(Number).filter(function (n) { return n >= 100 && n <= 20000; });
  return vals.length ? { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) } : null;
}

/* og:image 必须是完整网址；相对路径补上站点网域，没有图就用经纪人照片 */
function absoluteImage(imageUrl) {
  const first = String(imageUrl || '').split(',')[0].trim();
  if (!first) return SITE + '/image.png';
  if (/^https?:\/\//i.test(first)) return first;
  return SITE + '/' + first.replace(/^\/+/, '');
}

function page(opts) {
  const target = opts.target;
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + esc(opts.title) + '</title>',
    '<meta name="description" content="' + esc(opts.description) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="' + esc(AGENT) + '">',
    '<meta property="og:title" content="' + esc(opts.title) + '">',
    '<meta property="og:description" content="' + esc(opts.description) + '">',
    '<meta property="og:image" content="' + esc(opts.image) + '">',
    '<meta property="og:url" content="' + esc(opts.url) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    /* canonical 必须指回 /p/<id> 自己：有些爬虫会跟着 canonical 再抓一次，
       指向 /#property/<id> 的话 # 会被丢掉，结果抓到首页、读到首页的标签 */
    '<link rel="canonical" href="' + esc(opts.url) + '">',
    /* 真人：马上导去详情页。爬虫不跑 JS、也不跟 meta refresh，所以照样读得到上面的标签 */
    '<meta http-equiv="refresh" content="0; url=' + esc(target) + '">',
    '<script>location.replace(' + JSON.stringify(target) + ');</script>',
    '</head><body style="font-family:system-ui,sans-serif;padding:24px;">',
    '<p><a href="' + esc(target) + '">Continue to ' + esc(opts.title) + '</a></p>',
    '</body></html>',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  const id = String((req.query && req.query.id) || '').trim();

  /* 只接受 UUID —— id 会被拼进资料库查询和 HTML，不合格式的一律当成首页 */
  if (!UUID.test(id)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(page({
      title: 'Kareen Loke | Premium Real Estate',
      description: 'New launches in the Klang Valley, curated by ' + AGENT + '.',
      image: SITE + '/image.png',
      url: SITE,
      target: SITE + '/',
    }));
  }

  let p = null;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/properties?id=eq.' + id +
        '&select=id,title,location,price,size_sqft,bedrooms,bathrooms,tenure,status,property_highlight,image_url&limit=1',
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + SUPABASE_PUBLISHABLE_KEY } }
    );
    if (r.ok) {
      const rows = await r.json();
      p = rows && rows[0];
    }
  } catch (err) {
    console.error('Listing lookup failed:', err);
  }

  const target = SITE + '/#property/' + id;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!p) {
    /* 查不到（被删了或资料库暂时连不上）：仍然导去网站，只是没有房源专属的预览 */
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(404).send(page({
      title: 'Kareen Loke | Premium Real Estate',
      description: 'This listing is no longer available. See current new launches.',
      image: SITE + '/image.png',
      url: SITE + '/p/' + id,
      target: SITE + '/',
    }));
  }

  const price = Number(p.price) || 0;
  const range = sqftRange(p.size_sqft);
  const psf = range && price ? Math.round(price / range.min) : null;

  /* 预览卡只有两三行可用，先放客户最先比较的数字 */
  const headline = [
    price ? 'From RM ' + price.toLocaleString('en-MY') : '',
    psf ? 'RM ' + psf.toLocaleString('en-MY') + ' psf' : '',
    p.location || '',
  ].filter(Boolean).join(' · ');

  /* 资料是自由输入的：有时只写 "3"、"690 - 980"，单独的数字读不懂，补上单位 */
  function withUnit(v, unit, unitPattern) {
    const t = String(v || '').trim();
    if (!t) return '';
    return unitPattern.test(t) ? t : (/^[\d\s,\-–~.]+$/.test(t) ? t + ' ' + unit : t);
  }

  const specs = [
    withUnit(p.bedrooms, 'Beds', /bed|room|r\b/i),
    withUnit(p.bathrooms, 'Baths', /bath|b\b/i),
    withUnit(p.size_sqft, 'sqft', /sq\s*\.?\s*ft|sqft/i),
    String(p.tenure || '').trim(),
  ].filter(Boolean).join(' · ');

  const description = [headline, specs, p.property_highlight].filter(Boolean).join(' — ');

  /* 价格会改，但不常改：边缘快取 5 分钟，过期后先给旧的、背景再更新 */
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  return res.status(200).send(page({
    title: p.title + (p.location ? ' · ' + p.location : ''),
    description: description,
    image: absoluteImage(p.image_url),
    url: SITE + '/p/' + id,
    target: target,
  }));
};
