const { S3Client, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

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

  const { action, filenames, category, location } = req.body || {};
  if (!action || !Array.isArray(filenames) || !filenames.length) {
    res.status(400).json({ error: 'action and filenames[] required' });
    return;
  }
  if (!['trash', 'restore', 'delete-permanent', 'recategorize'].includes(action)) {
    res.status(400).json({ error: 'invalid action' });
    return;
  }
  const CAT_LIST = ['Mountains', 'Oceans', 'Forests', 'Wildlife', 'Sunsets', 'Waterfalls', 'Flowers', 'Rivers', 'Landscapes'];
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

  async function moveOne(fromKey, toKey) {
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `/${bucket}/${fromKey}`,
      Key: toKey,
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
  }

  const HASH_KEY = 'meta/photo-hashes.json';
  async function updateManifest(mutate) {
    let manifest = {};
    try {
      const out = await s3.send(new (require('@aws-sdk/client-s3').GetObjectCommand)({ Bucket: bucket, Key: HASH_KEY }));
      const chunks = [];
      for await (const c of out.Body) chunks.push(c);
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) { /* no manifest yet */ }
    mutate(manifest);
    await s3.send(new (require('@aws-sdk/client-s3').PutObjectCommand)({
      Bucket: bucket, Key: HASH_KEY, Body: JSON.stringify(manifest), ContentType: 'application/json',
    }));
  }

  const results = await Promise.all(filenames.map(async rawName => {
    const safe = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      if (action === 'trash') {
        await Promise.all([
          moveOne(`photos/${safe}`, `trash/photos/${safe}`),
          moveOne(`thumbs/${safe}`, `trash/thumbs/${safe}`).catch(()=>{}),
        ]);
      } else if (action === 'restore') {
        await Promise.all([
          moveOne(`trash/photos/${safe}`, `photos/${safe}`),
          moveOne(`trash/thumbs/${safe}`, `thumbs/${safe}`).catch(()=>{}),
        ]);
      } else if (action === 'delete-permanent') {
        await Promise.all([
          s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `trash/photos/${safe}` })),
          s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `trash/thumbs/${safe}` })).catch(()=>{}),
        ]);
        await updateManifest(m => { delete m[safe]; });
      } else if (action === 'recategorize') {
        const base = location === 'trash' ? 'trash/' : '';
        const stripped = safe.replace(/^[A-Za-z]+__/, '');
        const newSafe = `${category}__${stripped}`;
        if (newSafe !== safe) {
          await Promise.all([
            moveOne(`${base}photos/${safe}`, `${base}photos/${newSafe}`),
            moveOne(`${base}thumbs/${safe}`, `${base}thumbs/${newSafe}`).catch(()=>{}),
          ]);
          await updateManifest(m => { if (m[safe] !== undefined) { m[newSafe] = m[safe]; delete m[safe]; } });
        }
      }
      return { name: rawName, ok: true };
    } catch (e) {
      return { name: rawName, ok: false, error: String(e) };
    }
  }));

  res.status(200).json({ results });
};