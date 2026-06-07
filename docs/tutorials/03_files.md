# Tutorial 03 — File upload

> **Goal:** upload a file to Zenith and download it via a signed URL.

## 1. Upload a file

```bash
curl -X POST https://api.zenith.io/v1/files/photo.jpg \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

Response (201 Created):

```json
{
  "name": "abc123-photo.jpg",
  "url": "https://files.zenith.io/v1/acme-corp/abc123-photo.jpg",
  "contentType": "image/jpeg",
  "size": 12345
}
```

The file is encrypted at rest with SSE-KMS using a customer-managed key.

## 2. Download

```bash
curl -O https://files.zenith.io/v1/acme-corp/abc123-photo.jpg \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***"
```

## 3. Delete

```bash
curl -X DELETE https://api.zenith.io/v1/files/abc123-photo.jpg \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***"
```

## 4. SDK examples

### TypeScript

```typescript
const file = await zenith.files.upload({
  name: "photo.jpg",
  data: fs.readFileSync("photo.jpg"),
  contentType: "image/jpeg",
});
console.log(file.url);

const downloaded = await zenith.files.download(file.name);
fs.writeFileSync("downloaded.jpg", downloaded.data);

await zenith.files.delete(file.name);
```

### Python

```python
file = zenith.files.upload(
    name="photo.jpg",
    data=open("photo.jpg", "rb").read(),
    content_type="image/jpeg",
)
print(file["url"])

downloaded = zenith.files.download(file["name"])
open("downloaded.jpg", "wb").write(downloaded.data)

zenith.files.delete(file["name"])
```

## 5. Limits

| Limit                        | Default        |
| ---------------------------- | -------------- |
| Max file size                | 50 MB          |
| Allowed content types        | any (no enforcement by default) |
| Max files per tenant         | 1 000 000      |
| Max total storage per tenant | 10 TB          |

Custom limits can be set per-tenant via the admin API.
