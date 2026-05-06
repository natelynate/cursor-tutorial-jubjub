'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');

const PORT = Number(process.env.PORT) || 3847;
const POSTS_PATH = path.join(__dirname, 'data', 'posts.json');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const IMAGE_DIR = path.join(__dirname, 'image');
const FOUND_ITEMS_PATH = path.join(__dirname, 'data', 'found_items.json');
const LOST_ITEMS_PATH = path.join(__dirname, 'data', 'lost_items.json');

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/image', express.static(IMAGE_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        cb(null, UPLOADS_DIR);
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 20) || '';
      const safeExt = ext && /^[a-z0-9.]+$/i.test(ext) ? ext : '';
      const base = Date.now() + '-' + Math.random().toString(16).slice(2);
      cb(null, base + safeExt);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\//.test(file.mimetype || '');
    cb(ok ? null : new Error('Only image uploads are allowed'), ok);
  },
});

async function readPostsFile() {
  try {
    const raw = await fs.readFile(POSTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.posts)) data.posts = [];
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { posts: [] };
    throw err;
  }
}

async function writePostsFile(data) {
  await fs.mkdir(path.dirname(POSTS_PATH), { recursive: true });
  await fs.writeFile(POSTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function readJsonArrayFile(filePath, key) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { [key]: [] };
    if (!Array.isArray(data[key])) data[key] = [];
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { [key]: [] };
    throw err;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function tokenizeKeywords(s) {
  const raw = String(s || '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!raw) return [];
  const parts = raw.split(/\s+/g).filter(Boolean);
  return [...new Set(parts)].slice(0, 20);
}

function uniqNonEmpty(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [
    item.location,
    item.description,
    item.postedBy,
    item.createdBy,
    ...(Array.isArray(item.keywords) ? item.keywords : []),
    ...(Array.isArray(item.aiKeywords) ? item.aiKeywords : []),
    ...(Array.isArray(item.mergedKeywords) ? item.mergedKeywords : []),
    item.inputKeywords,
    item.inputDescription,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase())
    .join(' ');
  return hay.includes(q);
}

function inferMimeTypeFromFileName(fileName) {
  const ext = String(path.extname(fileName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function callOpenAiJson({ apiKey, model, messages, temperature }) {
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey.trim(),
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error('OpenAI request failed');
    err.status = r.status;
    err.detail = text.slice(0, 1000);
    throw err;
  }
  const json = JSON.parse(text);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('Invalid OpenAI response');
  return JSON.parse(content);
}

async function analyzeItemImage({ filePath, mimeType, mode }) {
  // mode: 'found' | 'lost'
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) return null;

  const buf = await fs.readFile(filePath);
  const b64 = buf.toString('base64');
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const sys = `너는 사내 분실물/습득물 등록을 돕는 AI다. 반드시 JSON만 출력한다.`;
  const userText =
    mode === 'found'
      ? `이미지에 보이는 물건을 한국어로 간단명료하게 설명하고, 검색용 키워드(태그)를 뽑아라.\n\n요구 형식(JSON only):\n{"description": "한두 문장", "keywords": ["키워드", "..."]}`
      : `이미지에 보이는 물건을 기반으로, 분실물 등록에 도움이 되는 검색 키워드(태그)를 뽑아라.\n\n요구 형식(JSON only):\n{"keywords": ["키워드", "..."]}`;

  const parsed = await callOpenAiJson({
    apiKey,
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
  });

  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const keywords = Array.isArray(parsed.keywords) ? uniqNonEmpty(parsed.keywords).slice(0, 12) : [];
  return { description, keywords };
}

async function extractKeywordsFromText({ inputKeywords, inputDescription }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) return null;

  const prompt = `다음 분실물 설명에서 검색에 유용한 키워드(태그) 5~10개를 한국어로 뽑아라.\n\n[입력 키워드]\n${inputKeywords || '(없음)'}\n\n[자세한 설명]\n${inputDescription || '(없음)'}\n\nJSON만 응답:\n{"keywords": ["..."]}`;

  const parsed = await callOpenAiJson({
    apiKey,
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
  });
  const keywords = Array.isArray(parsed.keywords) ? uniqNonEmpty(parsed.keywords).slice(0, 12) : [];
  return { keywords };
}

async function seedDemoDataIfEmpty() {
  const found = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
  const lost = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
  let changed = false;

  if (found.foundItems.length === 0) {
    const demoFound = [
      {
        id: Date.now() - 3000,
        location: '3층 대회의실',
        imageFileName: 'image1.jpg',
        imageRelPath: 'image/image1.jpg',
        description: '검정색 텀블러(컵)로 보이며 로고/스티커가 있을 수 있습니다.',
        keywords: ['텀블러', '컵', '검정'],
        status: 'stored',
        createdAt: nowIso(),
        createdBy: '데모',
        source: 'demo',
      },
      {
        id: Date.now() - 2000,
        location: '1층 로비',
        imageFileName: 'image2.jpg',
        imageRelPath: 'image/image2.jpg',
        description: '지갑으로 보이며 카드/현금이 들어있을 수 있습니다.',
        keywords: ['지갑', '카드', '가죽'],
        status: 'stored',
        createdAt: nowIso(),
        createdBy: '데모',
        source: 'demo',
      },
      {
        id: Date.now() - 1000,
        location: '주차장',
        imageFileName: 'image3.jpg',
        imageRelPath: 'image/image3.jpg',
        description: '차 키(키링 포함)로 보입니다.',
        keywords: ['차키', '자동차', '키링'],
        status: 'stored',
        createdAt: nowIso(),
        createdBy: '데모',
        source: 'demo',
      },
    ];
    found.foundItems = demoFound;
    await writeJsonFile(FOUND_ITEMS_PATH, found);
    changed = true;
  }

  if (lost.lostItems.length === 0) {
    lost.lostItems = [
      {
        id: Date.now() - 4000,
        inputKeywords: '검정 텀블러',
        inputDescription: '어제 오후 3층 근처에서 잃어버렸어요. 스티커가 붙어있을 수도 있어요.',
        imageFileName: 'image1.jpg',
        imageRelPath: 'image/image1.jpg',
        aiKeywords: ['텀블러', '검정'],
        mergedKeywords: ['검정', '텀블러', '컵'],
        status: 'open',
        createdAt: nowIso(),
        createdBy: '나',
        source: 'demo',
      },
    ];
    await writeJsonFile(LOST_ITEMS_PATH, lost);
    changed = true;
  }

  if (changed) {
    console.log('[demo] seeded found/lost JSON data');
  }
}

seedDemoDataIfEmpty().catch((e) => console.error('seedDemoDataIfEmpty failed', e));

app.get('/api/posts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const data = await readPostsFile();
    let posts = data.posts.slice();
    if (q) {
      posts = posts.filter((p) => {
        const loc = String(p.location || '').toLowerCase();
        const desc = String(p.description || '').toLowerCase();
        const by = String(p.postedBy || '').toLowerCase();
        return loc.includes(q) || desc.includes(q) || by.includes(q);
      });
    }
    res.json({ posts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read posts' });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const { location, description, postedBy } = req.body || {};
    if (!location || !description) {
      return res.status(400).json({ error: 'location and description are required' });
    }
    const data = await readPostsFile();
    const post = {
      id: Date.now(),
      location: String(location).trim(),
      description: String(description).trim(),
      postedAt: new Date().toLocaleString('ko-KR'),
      postedBy: postedBy != null && String(postedBy).trim() ? String(postedBy).trim() : '나',
    };
    data.posts.unshift(post);
    await writePostsFile(data);
    res.json({ post });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save post' });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const data = await readPostsFile();
    const idx = data.posts.findIndex((p) => Number(p.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    data.posts.splice(idx, 1);
    await writePostsFile(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ===================== New APIs (found-items / lost-items) =====================
app.get('/api/found-items', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const data = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
    let items = data.foundItems.slice();
    if (q) items = items.filter((it) => matchesQuery(it, q));
    res.json({ foundItems: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read found items' });
  }
});

app.post('/api/found-items', upload.single('image'), async (req, res) => {
  try {
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/5e8df2af-a849-40e1-b0c9-c94885113c23',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26b669'},body:JSON.stringify({sessionId:'26b669',runId:'save-debug-1',hypothesisId:'H3',location:'server.js:/api/found-items:entry',message:'found-items entry',data:{contentType:req.headers['content-type']||null,hasBody:!!req.body,hasFile:!!req.file,fileMimetype:req.file&&req.file.mimetype?req.file.mimetype:null,fileSize:req.file&&req.file.size?req.file.size:null,location:req.body&&req.body.location?String(req.body.location).slice(0,80):null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const location = String(req.body && req.body.location ? req.body.location : '').trim();
    if (!location) return res.status(400).json({ error: 'location is required' });
    if (!req.file) return res.status(400).json({ error: 'image is required' });

    const imageFileName = req.file.filename;
    const imageRelPath = 'uploads/' + imageFileName;
    const mimeType = String(req.file.mimetype || inferMimeTypeFromFileName(imageFileName));

    const data = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
    const item = {
      id: Date.now(),
      location,
      imageFileName,
      imageRelPath,
      imageMimeType: mimeType,
      description: '',
      keywords: [],
      status: 'stored',
      createdAt: nowIso(),
      createdBy: '나',
      source: 'upload',
    };
    data.foundItems.unshift(item);
    await writeJsonFile(FOUND_ITEMS_PATH, data);

    // AI 분석(가능하면) 후 description/keywords 업데이트
    try {
      const analysis = await analyzeItemImage({
        filePath: path.join(__dirname, imageRelPath),
        mimeType,
        mode: 'found',
      });
      if (analysis) {
        const latest = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
        const idx = latest.foundItems.findIndex((x) => Number(x.id) === Number(item.id));
        if (idx !== -1) {
          latest.foundItems[idx].description = analysis.description || latest.foundItems[idx].description;
          latest.foundItems[idx].keywords = analysis.keywords || latest.foundItems[idx].keywords;
          await writeJsonFile(FOUND_ITEMS_PATH, latest);
          return res.json({ foundItem: latest.foundItems[idx], ai: { ok: true } });
        }
      }
    } catch (e) {
      console.error('found-items AI analysis failed', e && e.status, e && e.detail ? e.detail : e);
      // 분석 실패해도 등록은 성공
    }

    res.json({ foundItem: item, ai: { ok: false } });
  } catch (e) {
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/5e8df2af-a849-40e1-b0c9-c94885113c23',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26b669'},body:JSON.stringify({sessionId:'26b669',runId:'save-debug-1',hypothesisId:'H2',location:'server.js:/api/found-items:catch',message:'found-items catch',data:{error:String(e&&e.message?e.message:e),code:e&&e.code?e.code:null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.error(e);
    res.status(500).json({ error: 'Failed to save found item' });
  }
});

app.patch('/api/found-items/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    if (status !== 'stored' && status !== 'returned') {
      return res.status(400).json({ error: 'invalid status' });
    }
    const data = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
    const idx = data.foundItems.findIndex((x) => Number(x.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    data.foundItems[idx].status = status;
    await writeJsonFile(FOUND_ITEMS_PATH, data);
    res.json({ foundItem: data.foundItems[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.delete('/api/found-items/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await readJsonArrayFile(FOUND_ITEMS_PATH, 'foundItems');
    const idx = data.foundItems.findIndex((x) => Number(x.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const removed = data.foundItems.splice(idx, 1)[0];
    await writeJsonFile(FOUND_ITEMS_PATH, data);
    res.json({ ok: true, removed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete found item' });
  }
});

app.get('/api/lost-items', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const data = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
    let items = data.lostItems.slice();
    if (q) items = items.filter((it) => matchesQuery(it, q));
    res.json({ lostItems: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read lost items' });
  }
});

app.post('/api/lost-items', upload.single('image'), async (req, res) => {
  try {
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/5e8df2af-a849-40e1-b0c9-c94885113c23',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26b669'},body:JSON.stringify({sessionId:'26b669',runId:'save-debug-1',hypothesisId:'H3',location:'server.js:/api/lost-items:entry',message:'lost-items entry',data:{contentType:req.headers['content-type']||null,hasBody:!!req.body,hasFile:!!req.file,fileMimetype:req.file&&req.file.mimetype?req.file.mimetype:null,fileSize:req.file&&req.file.size?req.file.size:null,inputKeywords:req.body&&req.body.inputKeywords?String(req.body.inputKeywords).slice(0,80):null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const inputKeywords = String(req.body && req.body.inputKeywords ? req.body.inputKeywords : '').trim();
    const inputDescription = String(req.body && req.body.inputDescription ? req.body.inputDescription : '').trim();
    if (!inputKeywords) return res.status(400).json({ error: 'inputKeywords is required' });

    let imageFileName = null;
    let imageRelPath = null;
    let mimeType = null;
    if (req.file) {
      imageFileName = req.file.filename;
      imageRelPath = 'uploads/' + imageFileName;
      mimeType = String(req.file.mimetype || inferMimeTypeFromFileName(imageFileName));
    }

    const data = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
    const merged = uniqNonEmpty([...tokenizeKeywords(inputKeywords), ...tokenizeKeywords(inputDescription)]);
    const item = {
      id: Date.now(),
      inputKeywords,
      inputDescription,
      imageFileName,
      imageRelPath,
      imageMimeType: mimeType,
      aiKeywords: [],
      mergedKeywords: merged,
      status: 'open',
      createdAt: nowIso(),
      createdBy: '나',
      source: 'upload',
    };
    data.lostItems.unshift(item);
    await writeJsonFile(LOST_ITEMS_PATH, data);

    // AI 키워드 보강(가능하면)
    try {
      let ai = null;
      if (imageRelPath) {
        ai = await analyzeItemImage({
          filePath: path.join(__dirname, imageRelPath),
          mimeType: mimeType || inferMimeTypeFromFileName(imageFileName),
          mode: 'lost',
        });
      } else {
        ai = await extractKeywordsFromText({ inputKeywords, inputDescription });
      }
      if (ai) {
        const aiKeywords = Array.isArray(ai.keywords) ? ai.keywords : [];
        const mergedKeywords = uniqNonEmpty([
          ...tokenizeKeywords(inputKeywords),
          ...tokenizeKeywords(inputDescription),
          ...aiKeywords,
        ]);

        const latest = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
        const idx = latest.lostItems.findIndex((x) => Number(x.id) === Number(item.id));
        if (idx !== -1) {
          latest.lostItems[idx].aiKeywords = aiKeywords;
          latest.lostItems[idx].mergedKeywords = mergedKeywords;
          await writeJsonFile(LOST_ITEMS_PATH, latest);
          return res.json({ lostItem: latest.lostItems[idx], ai: { ok: true } });
        }
      }
    } catch (e) {
      console.error('lost-items AI analysis failed', e && e.status, e && e.detail ? e.detail : e);
    }

    res.json({ lostItem: item, ai: { ok: false } });
  } catch (e) {
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/5e8df2af-a849-40e1-b0c9-c94885113c23',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26b669'},body:JSON.stringify({sessionId:'26b669',runId:'save-debug-1',hypothesisId:'H2',location:'server.js:/api/lost-items:catch',message:'lost-items catch',data:{error:String(e&&e.message?e.message:e),code:e&&e.code?e.code:null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.error(e);
    res.status(500).json({ error: 'Failed to save lost item' });
  }
});

app.patch('/api/lost-items/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    if (status !== 'open' && status !== 'found') {
      return res.status(400).json({ error: 'invalid status' });
    }
    const data = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
    const idx = data.lostItems.findIndex((x) => Number(x.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    data.lostItems[idx].status = status;
    await writeJsonFile(LOST_ITEMS_PATH, data);
    res.json({ lostItem: data.lostItems[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.delete('/api/lost-items/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await readJsonArrayFile(LOST_ITEMS_PATH, 'lostItems');
    const idx = data.lostItems.findIndex((x) => Number(x.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const removed = data.lostItems.splice(idx, 1)[0];
    await writeJsonFile(LOST_ITEMS_PATH, data);
    res.json({ ok: true, removed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete lost item' });
  }
});

app.post('/api/match', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not set in .env' });
  }
  const { lostKeywords, lostDescription, foundDescription, foundLocation } = req.body || {};
  if (!lostKeywords || !foundDescription) {
    return res.status(400).json({ error: 'lostKeywords and foundDescription are required' });
  }
  const kw = String(lostKeywords).trim();
  const lostDesc = lostDescription != null ? String(lostDescription).trim() : '';
  const foundDesc = String(foundDescription).trim();
  const foundLoc = foundLocation != null ? String(foundLocation).trim() : '';

  const prompt = `너는 사내 분실물 매칭 AI다. 누군가 잃어버린 물건과 누군가 발견·등록한 물건이 같은 물건일 가능성을 판단해라.

[잃어버린 사람의 정보]
키워드: ${kw}
설명: ${lostDesc || '(없음)'}

[발견·등록된 물건]
장소: ${foundLoc || '(없음)'}
설명: ${foundDesc}

JSON만 응답해. 다른 텍스트 금지:
{"match": true/false (실제로 같은 물건일 확률이 45% 이상이면 true), "similarity": 0-100 정수 (같을 확률을 퍼센트로), "reason": "한 문장 판단 근거 (한국어)"}`;

  try {
    const parsed = await callOpenAiJson({
      apiKey,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    res.json(parsed);
  } catch (e) {
    console.error('match failed', e && e.status, e && e.detail ? e.detail : e);
    if (e && e.status) return res.status(502).json({ error: 'OpenAI request failed', detail: String(e.detail || '').slice(0, 500) });
    res.status(500).json({ error: 'Match request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Jubjub server http://localhost:${PORT}/jubjub.html`);
});

