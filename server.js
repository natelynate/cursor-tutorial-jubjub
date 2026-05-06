'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const PORT = Number(process.env.PORT) || 3847;
const POSTS_PATH = path.join(__dirname, 'data', 'posts.json');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(__dirname));

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
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey.trim(),
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('OpenAI error', r.status, text);
      return res.status(502).json({ error: 'OpenAI request failed', detail: text.slice(0, 500) });
    }
    const json = JSON.parse(text);
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) return res.status(502).json({ error: 'Invalid OpenAI response' });
    const parsed = JSON.parse(content);
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Match request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Jubjub server http://localhost:${PORT}/jubjub.html`);
});

