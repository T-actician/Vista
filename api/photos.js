const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = async (req, res) => {
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
      listAll('photos/'),
      listAll('thumbs/'),
    ]);

    const thumbKeys = new Set(thumbObjs.map(o => o.Key.replace('thumbs/', '')));

    const photos = await Promise.all(photoObjs.map(async o => {
      const filename = o.Key.replace('photos/', '');
      const hasThumb = thumbKeys.has(filename);
      const name = filename.replace(/^\d+_/, '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const [url, thumbUrl] = await Promise.all([
        signedGet(o.Key),
        hasThumb ? signedGet(`thumbs/${filename}`) : signedGet(o.Key),
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