const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

module.exports = async (req, res) => {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
  });

  const bucket = process.env.B2_BUCKET;
  const base = `https://${bucket}.${process.env.B2_ENDPOINT}`;

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

  try {
    const [photoObjs, thumbObjs] = await Promise.all([
      listAll('photos/'),
      listAll('thumbs/'),
    ]);

    const thumbKeys = new Set(thumbObjs.map(o => o.Key.replace('thumbs/', '')));

    const photos = photoObjs.map(o => {
      const filename = o.Key.replace('photos/', '');
      const hasThumb = thumbKeys.has(filename);
      const name = filename.replace(/^\d+_/, '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      return {
        id: o.Key,
        filename,
        name,
        url: `${base}/${o.Key}`,
        thumbUrl: hasThumb ? `${base}/thumbs/${filename}` : `${base}/${o.Key}`,
        size: o.Size,
        lastModified: o.LastModified,
      };
    }).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    res.status(200).json({ photos });
  } catch (e) {
    res.status(500).json({ error: 'Could not list photos', detail: String(e) });
  }
};