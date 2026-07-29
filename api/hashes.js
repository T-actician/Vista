const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const HASH_KEY = 'meta/photo-hashes.json';

function s3client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APP_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function readManifest(s3, bucket) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: HASH_KEY }));
    return JSON.parse(await streamToString(out.Body));
  } catch (e) {
    return {};
  }
}

module.exports = async (req, res) => {
  const s3 = s3client();
  const bucket = process.env.B2_BUCKET;

  if (req.method === 'GET') {
    const manifest = await readManifest(s3, bucket);
    res.status(200).json(manifest);
    return;
  }

  if (req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user || userData.user.id !== process.env.ADMIN_UID) {
      res.status(403).json({ error: 'Not admin' }); return;
    }

    const { set, remove, rename } = req.body || {};
    const manifest = await readManifest(s3, bucket);

    if (set) for (const [filename, hash] of Object.entries(set)) manifest[filename] = hash;
    if (Array.isArray(remove)) for (const filename of remove) delete manifest[filename];
    if (rename) for (const [oldName, newName] of Object.entries(rename)) {
      if (manifest[oldName] !== undefined) { manifest[newName] = manifest[oldName]; delete manifest[oldName]; }
    }

    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: HASH_KEY, Body: JSON.stringify(manifest), ContentType: 'application/json',
    }));
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
