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

/* 可以喂给模型的档案类型 */
const ALLOWED_MIME = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf)$/;

/* 直接从浏览器上传：Vercel 的请求体上限是 4.5MB，
   而 base64 会让体积膨胀约 33%，所以原始档案实际只能到 3.3MB 左右。 */
const MAX_UPLOAD_BYTES = 3.3 * 1024 * 1024;

/* 由服务器去抓网址：不受 Vercel 请求体限制，
   瓶颈变成 Gemini 单次请求约 20MB 的上限，留点余裕抓 15MB。 */
const MAX_FETCH_BYTES = 15 * 1024 * 1024;

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

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

function buildPrompt(rawText, hasAttachment) {
  return [
    'You are a top-tier Malaysian real estate assistant. Extract property details from the provided material and output strictly in JSON format.',
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
    hasAttachment
      ? 'A file is attached (a brochure, price list, or photo). Read it in full — including tables and floor plan schedules — and treat it as the primary source. Where a price list gives several unit types, use the smallest/lowest figures for price and take the full span for size_sqft and bedrooms (e.g. "690 - 980").'
      : null,
    rawText
      ? 'Text to analyze: ' + rawText
      : 'No text was pasted — extract everything from the attached file.',
  ]
    .filter(function (line) { return line !== null; })
    .join('\n');
}

/* --------------------------------------------------------------------------
 * 附件有两条来路：
 *   1. 浏览器直接上传的档案（已经是 base64）
 *   2. 一个网址，由服务器抓下来转 base64
 * Gemini 不接受任意网址（fileUri 只认 Files API），所以两条路最后
 * 都得变成内联的 base64。
 * ----------------------------------------------------------------------- */

/* 使用者输入造成的错误，标记成 400 —— 回 500 会让人以为是服务器坏了 */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/* 来路 1：浏览器上传 */
function validateUpload(file) {
  const mimeType = String(file.mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_MIME.test(mimeType)) {
    throw badRequest('Only PDF and image files are supported (got: ' + (mimeType || 'unknown') + ').');
  }

  const bytes = Buffer.byteLength(String(file.data || ''), 'base64');
  if (!bytes) throw badRequest('That file came through empty.');
  if (bytes > MAX_UPLOAD_BYTES) {
    throw badRequest(
      'That file is ' + mb(bytes) + 'MB. Direct upload tops out at ' + mb(MAX_UPLOAD_BYTES) +
        'MB — host it somewhere and paste the URL instead.'
    );
  }

  return { mime_type: mimeType, data: file.data };
}

/* 来路 2：服务器抓网址 */
async function fetchAsInlineData(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw badRequest('Could not reach that URL.');
  }
  if (!res.ok) throw badRequest('Could not download that file (HTTP ' + res.status + ').');

  const mimeType = (res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_MIME.test(mimeType)) {
    throw badRequest('That URL is not a PDF or an image (got: ' + (mimeType || 'unknown') + ').');
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_FETCH_BYTES) {
    throw badRequest('That file is ' + mb(buf.byteLength) + 'MB, over the ' + mb(MAX_FETCH_BYTES) + 'MB limit.');
  }

  return { mime_type: mimeType, data: buf.toString('base64') };
}

/* --------------------------------------------------------------------------
 * Provider: Gemini
 * ----------------------------------------------------------------------- */
async function callGemini(prompt, attachment) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const parts = [{ text: prompt }];

  /* Gemini 原生看得懂 PDF —— 文字、表格、版面都读得到，
     不需要我们先把它转成图片或抽文字。 */
  if (attachment) {
    parts.push({ inline_data: attachment });
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
async function callOpenAI(prompt, attachment) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  /* chat/completions 的 image_url 只吃图片，PDF 要走另一套 API。
     与其悄悄忽略附件、让使用者以为读进去了，不如直说。 */
  if (attachment && attachment.mime_type === 'application/pdf') {
    throw new Error('PDF reading needs Gemini. Set AI_PROVIDER=gemini in Vercel, or paste the text instead.');
  }

  const content = attachment
    ? [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: 'data:' + attachment.mime_type + ';base64,' + attachment.data },
        },
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
  const upload = body.file && body.file.data ? body.file : null;

  if (!rawText && !photoUrl && !upload) {
    return res.status(400).json({ error: 'Nothing to analyse.' });
  }

  try {
    /* 上传的档案优先于贴上的网址 —— 两个都给的话以档案为准 */
    let attachment = null;
    if (upload) {
      attachment = validateUpload(upload);
    } else if (photoUrl) {
      attachment = await fetchAsInlineData(photoUrl);
    }

    const prompt = buildPrompt(rawText, !!attachment);
    const raw =
      provider === 'gemini'
        ? await callGemini(prompt, attachment)
        : await callOpenAI(prompt, attachment);

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
    const status = err.status || 500;
    /* 400 是使用者给错东西，不是服务器坏了 —— 不用整串 stack 污染日志 */
    if (status === 400) {
      console.warn('ai-extract rejected input:', err.message);
    } else {
      console.error('ai-extract failed:', err);
    }
    return res.status(status).json({ error: err.message || 'Extraction failed.' });
  }
};
