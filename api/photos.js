const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const CAT_LIST = ['Mountains','Oceans','Forests','Wildlife','Sunsets','Waterfalls','Flowers','Rivers','Landscapes'];
const META_KEY = 'meta/photo-meta.json';

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

  const photoPrefix = 'photos/';
  const thumbPrefix = 'thumbs/';

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

  async function readMeta() {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: META_KEY }));
      const chunks = [];
      for await (const c of out.Body) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) { return {}; }
  }

  const MEDIA_BASE = process.env.MEDIA_WORKER_URL; // e.g. https://vista-media.<subdomain>.workers.dev

  function mediaUrl(key, downloadName) {
    const u = `${MEDIA_BASE}/${key}`;
    return downloadName ? `${u}?dl=${encodeURIComponent(downloadName)}` : u;
  }

  try {
    const [photoObjs, thumbObjs, meta] = await Promise.all([
      listAll(photoPrefix),
      listAll(thumbPrefix),
      readMeta(),
    ]);

    const thumbKeys = new Set(thumbObjs.map(o => o.Key.replace(thumbPrefix, '')));

    const photos = (await Promise.all(photoObjs.map(async o => {
      const filename = o.Key.replace(photoPrefix, '');
      const trashed = !!(meta[filename] && meta[filename].trashed);
      if (trashed !== wantsTrash) return null;

      const hasThumb = thumbKeys.has(filename);
      const catMatch = filename.match(/^([A-Za-z]+)__(.+)$/);
      let category = 'Landscapes';
      let rest = filename;
      if (catMatch && CAT_LIST.includes(catMatch[1])) {
        category = catMatch[1];
        rest = catMatch[2];
      }
      if (meta[filename] && meta[filename].category) category = meta[filename].category;

      const name = rest.replace(/^\d+_/, '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const ext = (filename.match(/\.[^.]+$/) || ['.jpg'])[0];
      const downloadName = `${name.replace(/[^a-z0-9 ]/gi, '').trim() || 'vista-photo'}${ext}`;
      const url = mediaUrl(o.Key);
      const thumbUrl = hasThumb ? mediaUrl(`${thumbPrefix}${filename}`) : url;
      const downloadUrl = mediaUrl(o.Key, downloadName);
      return {
        id: o.Key,
        filename,
        name,
        category,
        url,
        thumbUrl,
        downloadUrl,
        size: o.Size,
        lastModified: o.LastModified,
      };
    }))).filter(Boolean);

    photos.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    if (!wantsTrash) {
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.status(200).json({ photos });
  } catch (e) {
    res.status(500).json({ error: 'Could not list photos', detail: String(e) });
  }
};
