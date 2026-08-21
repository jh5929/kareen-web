/* =============================================================================
 *  /api/ai-extract  —  Vercel Serverless Function
 * =============================================================================
 *  为什么存在：AI 的 key 绝对不能出现在 admin.html 里。
 *  浏览器打得开的文件，任何人都读得到；而且这个仓库是公开的，
 *  key 一旦提交上 GitHub，供应商会自动吊销它（OpenAI 那把就是这样死的）。
 *
 *  所以：前端只调 /api/ai-extract，key 只存在于 Vercel 的环境变量里。
 *
 *  环境变量（Vercel → Project → Settings → Environment Variables）：
 *
 *    用 Gemini（目前的选择）：
 *      GEMINI_API_KEY    必填
 *      GEMINI_MODEL      选填，默认 gemini-3.5-flash
 *                        （实测 6 秒左右；3.6-flash / flash-latest 要 30–40 秒，
 *                          质量没差别。2.5-flash 对新账号已下线，别用。）
 *
 *    用 OpenAI（等新 key 建好后可切回）：
 *      OPENAI_API_KEY    必填
 *      OPENAI_MODEL      选填，默认 gpt-4o
 *
 *    AI_PROVIDER         选填，gemini 或 openai。不填就看哪个 key 存在，
 *                        两个都有的话优先用 Gemini。
 *
 *    SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY   选填，不填用下面的默认值
 * ========================================================================== */

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://fryynuhukubqppilqpfk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_GnK_xyRsCtIO7vtE9k-zPw_eSs4Erd0';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB，避免拖垮 function

/* --------------------------------------------------------------------------
 * 校验请求者确实是登入的 admin。
 * 不校验的话，这个 endpoint 等于把你的 AI 额度开放给全世界白嫖。
 * ----------------------------------------------------------------------- */
async function verifyUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: 'Bearer ' + token,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('Supabase token check failed:', err);
    return null;
  }
}

function buildPrompt(rawText) {
  return [
    'You are a top-tier Malaysian real estate assistant. Extract property details from the provided text and output strictly in JSON format.',
    'If information is missing, leave it as an empty string.',
    'Return ONLY the raw JSON object, with no markdown code fences around it.',
    '',
    'Strict value rules for dropdowns:',
    '- property_type: MUST BE EXACTLY "Residential", "Commercial", or "Land". Defaults to "Residential".',
    '- tenure: MUST BE EXACTLY "Freehold" or "Leasehold".',
    '- status: MUST BE EXACTLY "Launching Soon", "Ready 2025", or "Completed". Defaults to "Launching Soon".',
    '- price: MUST be a pure number without RM or commas (e.g., 550000). If not found, use 0.',
    '',
    'Required JSON keys:',
    '{',
    '  "title": "Property Name",',
    '  "location": "Area or City",',
    '  "price": 500000,',
    '  "property_type": "Residential",',
    '  "tenure": "Freehold",',
    '  "status": "Launching Soon",',
    '  "bedrooms": "e.g., 3 Beds",',
    '  "carparks": "e.g., 2 Lots",',
    '  "size_sqft": "e.g., 1000",',
    '  "facilities": "e.g., Pool, Gym, Security",',
    '  "property_highlight": "1 short sentence of the main selling point",',
    '  "description": "Full text description",',
    '  "nearby_amenities": {',
    '    "transportation": ["LRT X"],',
    '    "shopping": ["Mall Y"]',
    '  }',
    '}',
    '',
    'Text to analyze: ' + rawText,
  ].join('\n');
}

/* --------------------------------------------------------------------------
 * Gemini 不接受任意的图片网址（fileUri 只认 Files API），
 * 所以图片得由服务器抓下来转成 base64 内联进去。
 * ----------------------------------------------------------------------- */
async function fetchImageAsInlineData(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('Could not download that image (HTTP ' + res.status + ').');

  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!mimeType.startsWith('image/')) {
    throw new Error('That URL is not an image (' + mimeType + ').');
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('That image is larger than 5MB. Use a smaller one.');
  }

  return { mime_type: mimeType, data: buf.toString('base64') };
}

/* --------------------------------------------------------------------------
 * Provider: Gemini
 * ----------------------------------------------------------------------- */
async function callGemini(prompt, photoUrl) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const parts = [{ text: prompt }];

  if (photoUrl) {
    parts.push({ inline_data: await fetchImageAsInlineData(photoUrl) });
  }

  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Gemini error:', res.status, data && data.error);
    if (res.status === 400 || res.status === 403) {
      throw new Error('AI key rejected by Google. Check GEMINI_API_KEY in Vercel.');
    }
    throw new Error((data && data.error && data.error.message) || 'Gemini returned ' + res.status);
  }

  const candidate = data.candidates && data.candidates[0];
  const text =
    candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(function (p) { return p.text || ''; }).join('')
      : '';

  if (!text) {
    console.error('Gemini returned no text. finishReason:', candidate && candidate.finishReason);
    throw new Error('The AI returned an empty response. Try rephrasing the text.');
  }
  return text;
}

/* --------------------------------------------------------------------------
 * Provider: OpenAI
 * ----------------------------------------------------------------------- */
async function callOpenAI(prompt, photoUrl) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const content = photoUrl
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: photoUrl } },
      ]
    : [{ type: 'text', text: prompt }];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: content }],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('OpenAI error:', res.status, data && data.error);
    /* key 相关的错误不要原样丢给前端 —— 那是服务器配置问题，不是使用者的问题 */
    if (res.status === 401) {
      throw new Error('AI key rejected by OpenAI. Check OPENAI_API_KEY in Vercel.');
    }
    throw new Error((data && data.error && data.error.message) || 'OpenAI returned ' + res.status);
  }

  return data.choices[0].message.content;
}

/* --------------------------------------------------------------------------
 * 归一化模型输出。
 * 模型有时会把 property_highlight 之类的栏位回成阵列或物件，
 * 直接塞进 <input> 会变成 "a,b,c" 或 "[object Object]"。
 * 这里统一压成表单能用的字串 / 数字。
 * ----------------------------------------------------------------------- */
const TEXT_FIELDS = [
  'title',
  'location',
  'property_type',
  'tenure',
  'status',
  'bedrooms',
  'carparks',
  'size_sqft',
  'facilities',
  'property_highlight',
  'description',
];

function toText(value, joiner) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(function (v) { return toText(v, ' '); }).filter(Boolean).join(joiner);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function normalise(result) {
  const out = Object.assign({}, result);

  TEXT_FIELDS.forEach(function (field) {
    if (field in out) {
      /* facilities 是清单，逗号分隔读起来最顺；其余当成句子接起来 */
      out[field] = toText(out[field], field === 'facilities' ? ', ' : ' ');
    }
  });

  /* property_highlight 说好只要一句话，模型给多句时取第一句 */
  if (out.property_highlight) {
    const first = out.property_highlight.split(/(?<=[.!?])\s+/)[0];
    if (first) out.property_highlight = first.trim();
  }

  /* price 必须是纯数字，"RM 663,120" 这种要洗掉 */
  if ('price' in out) {
    const digits = String(out.price).replace(/[^0-9.]/g, '');
    const num = parseFloat(digits);
    out.price = isNaN(num) ? 0 : num;
  }

  if (out.nearby_amenities && typeof out.nearby_amenities !== 'object') {
    delete out.nearby_amenities;
  }

  return out;
}

/* --------------------------------------------------------------------------
 * Handler
 * ----------------------------------------------------------------------- */
function pickProvider() {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase();
  if (forced === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (forced === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : null;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  /* 先验身份，再看配置。
     顺序反过来的话，任何陌生人 POST 一下就能知道这台服务器有没有配 key ——
     那是内部状态，不该对外泄露。 */
  const user = await verifyUser(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Not authorised. Please log in again.' });
  }

  const provider = pickProvider();
  if (!provider) {
    console.error('No AI key configured on this deployment.');
    return res.status(500).json({
      error: 'Server has no AI key. Set GEMINI_API_KEY (or OPENAI_API_KEY) in Vercel.',
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const rawText = (body.rawText || '').trim();
  const photoUrl = (body.photoUrl || '').trim();

  if (!rawText && !photoUrl) {
    return res.status(400).json({ error: 'Nothing to analyse.' });
  }

  try {
    const prompt = buildPrompt(rawText);
    const raw =
      provider === 'gemini'
        ? await callGemini(prompt, photoUrl)
        : await callOpenAI(prompt, photoUrl);

    /* 保险起见：模型偶尔还是会用 markdown 代码围栏把 JSON 包起来，
       这里只取第一个 { 到最后一个 } 之间的内容 */
    const cleaned = raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('Model did not return valid JSON:', cleaned.slice(0, 500));
      return res.status(502).json({ error: 'The AI returned malformed JSON. Try again.' });
    }

    return res.status(200).json(normalise(parsed));
  } catch (err) {
    console.error('ai-extract failed:', err);
    return res.status(500).json({ error: err.message || 'Extraction failed.' });
  }
};
