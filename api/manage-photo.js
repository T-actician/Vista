const { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const META_KEY = 'meta/photo-meta.json';
const HASH_KEY = 'meta/photo-hashes.json';
const CAT_LIST = ['Mountains', 'Oceans', 'Forests', 'Wildlife', 'Sunsets', 'Waterfalls', 'Flowers', 'Rivers', 'Landscapes'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing auth token' });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user || userData.user.id !== process.env.ADMIN_UID) {
    res.status(403).json({ error: 'Not admin' });
    return;
  }

  const { action, filenames, category } = req.body || {};
  if (!action || !Array.isArray(filenames) || !filenames.length) {
    res.status(400).json({ error: 'action and filenames[] required' });
    return;
  }
  if (!['trash', 'restore', 'delete-permanent', 'recategorize'].includes(action)) {
    res.status(400).json({ error: 'invalid action' });
    return;
  }
  if (action === 'recategorize' && !CAT_LIST.includes(category)) {
    res.status(400).json({ error: 'invalid category' });
    return;
  }

  const bucket = process.env.B2_BUCKET;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  async function readJson(key) {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const c of out.Body) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) { return {}; }
  }
  async function writeJson(key, obj) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
  }

  const safeNames = filenames.map(rawName => String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_'));

  try {
    if (action === 'delete-permanent') {
      // Only real S3 op here is Delete, which B2 does not bill/count as a download.
      const results = await Promise.all(safeNames.map(async safe => {
        try {
          await Promise.all([
            s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `photos/${safe}` })),
            s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `thumbs/${safe}` })).catch(() => {}),
          ]);
          return { name: safe, ok: true };
        } catch (e) {
          return { name: safe, ok: false, error: String(e) };
        }
      }));
      const [meta, hashes] = await Promise.all([readJson(META_KEY), readJson(HASH_KEY)]);
      safeNames.forEach(safe => { delete meta[safe]; delete hashes[safe]; });
      await Promise.all([writeJson(META_KEY, meta), writeJson(HASH_KEY, hashes)]);
      res.status(200).json({ results });
      return;
    }

    // trash / restore / recategorize: metadata flag only, zero file moves, zero B2 downloads
    const meta = await readJson(META_KEY);
    safeNames.forEach(safe => {
      meta[safe] = meta[safe] || {};
      if (action === 'trash') meta[safe].trashed = true;
      if (action === 'restore') meta[safe].trashed = false;
      if (action === 'recategorize') meta[safe].category = category;
    });
    await writeJson(META_KEY, meta);
    res.status(200).json({ results: safeNames.map(name => ({ name, ok: true })) });
  } catch (e) {
    res.status(500).json({ error: 'Action failed', detail: String(e) });
  }
};