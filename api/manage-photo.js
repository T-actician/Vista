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

  const { action, filenames } = req.body || {};
  if (!action || !Array.isArray(filenames) || !filenames.length) {
    res.status(400).json({ error: 'action and filenames[] required' });
    return;
  }
  if (!['trash', 'restore', 'delete-permanent'].includes(action)) {
    res.status(400).json({ error: 'invalid action' });
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
      CopySource: `/${bucket}/${encodeURIComponent(fromKey)}`,
      Key: toKey,
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
  }

  const results = [];
  for (const rawName of filenames) {
    const safe = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      if (action === 'trash') {
        await moveOne(`photos/${safe}`, `trash/photos/${safe}`);
        try { await moveOne(`thumbs/${safe}`, `trash/thumbs/${safe}`); } catch (e) {}
      } else if (action === 'restore') {
        await moveOne(`trash/photos/${safe}`, `photos/${safe}`);
        try { await moveOne(`trash/thumbs/${safe}`, `thumbs/${safe}`); } catch (e) {}
      } else if (action === 'delete-permanent') {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `trash/photos/${safe}` }));
        try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `trash/thumbs/${safe}` })); } catch (e) {}
      }
      results.push({ name: rawName, ok: true });
    } catch (e) {
      results.push({ name: rawName, ok: false, error: String(e) });
    }
  }

  res.status(200).json({ results });
};