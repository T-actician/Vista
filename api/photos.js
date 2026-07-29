const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const wantsTrash = req.query && req.query.trash === '1';

  if (wantsTrash) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user || userData.user.id !== process.env.ADMIN_UID) {
      res.status(403).json({ error: 'Not admin' }); return;
    }
  }

  const photoPrefix = wantsTrash ? 'trash/photos/' : 'photos/';
  const thumbPrefix = wantsTrash ? 'trash/thumbs/' : 'thumbs/';

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  const bucket = process.env.B2_BUCKET;

  async function listAll(prefix) {
    let items = [];
    let token;
    do {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token,
      }));
      items = items.concat(out.Contents || []);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return items;
  }

  function signedGet(key) {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 21600 }); // 6 hours
  }

  try {
    const [photoObjs, thumbObjs] = await Promise.all([
      listAll(photoPrefix),
      listAll(thumbPrefix),
    ]);

    const thumbKeys = new Set(thumbObjs.map(o => o.Key.replace(thumbPrefix, '')));

    const photos = await Promise.all(photoObjs.map(async o => {
      const filename = o.Key.replace(photoPrefix, '');
      const hasThumb = thumbKeys.has(filename);
      const name = filename.replace(/^\d+_/, '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const [url, thumbUrl] = await Promise.all([
        signedGet(o.Key),
        hasThumb ? signedGet(`${thumbPrefix}${filename}`) : signedGet(o.Key),
      ]);
      return {
        id: o.Key,
        filename,
        name,
        url,
        thumbUrl,
        size: o.Size,
        lastModified: o.LastModified,
      };
    }));

    photos.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    res.status(200).json({ photos });
  } catch (e) {
    res.status(500).json({ error: 'Could not list photos', detail: String(e) });
  }
};