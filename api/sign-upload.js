const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }
  if (userData.user.id !== process.env.ADMIN_UID) {
    res.status(403).json({ error: 'Not admin' });
    return;
  }

  const { filename, contentType, kind } = req.body || {};
  if (!filename || !contentType) {
    res.status(400).json({ error: 'filename and contentType required' });
    return;
  }
  if (kind !== 'photo' && kind !== 'thumb') {
    res.status(400).json({ error: 'kind must be photo or thumb' });
    return;
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefix = kind === 'thumb' ? 'thumbs/' : 'photos/';
  const key = `${prefix}${safeName}`;

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
  });

  const command = new PutObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
  const publicUrl = `https://${process.env.B2_BUCKET}.${process.env.B2_ENDPOINT}/${key}`;

  res.status(200).json({ uploadUrl, publicUrl, key });
};