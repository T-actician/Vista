const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: false } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }
  if (userData.user.id !== process.env.ADMIN_UID) {
    res.status(403).json({ error: 'Not admin' });
    return;
  }

  const { filename, kind } = req.query;
  if (!filename || (kind !== 'photo' && kind !== 'thumb')) {
    res.status(400).json({ error: 'filename and valid kind required' });
    return;
  }

  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefix = kind === 'thumb' ? 'thumbs/' : 'photos/';
  const key = `${prefix}${safeName}`;

  const body = await readBody(req);
  if (body.length > 4_400_000) {
    res.status(413).json({ error: 'File too large (max ~4.3MB after resize)' });
    return;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.B2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    res.status(200).json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', detail: String(e) });
  }
};