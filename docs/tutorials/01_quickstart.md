# Quickstart — Build a To-Do app in 5 minutes

> **Goal:** store and list "to-do" items using the Zenith REST API from any language.
> **Prerequisites:** API key (any type), 5 minutes.

## 1. Get your keys

If you just signed up, your keys are in your 1Password vault under
"Zenith". The relevant ones for this tutorial:

- **App ID:** `acme-corp-prod`
- **API key (any):** `sk_live_***` (or `pk_live_***` for browser)

## 2. Make your first request

```bash
curl https://api.zenith.io/v1/classes/Todo \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk", "done": false}'
```

Expected response (201 Created):

```json
{
  "objectId": "abc123",
  "createdAt": "2026-06-06T12:00:00.000Z"
}
```

## 3. Query your to-dos

```bash
curl "https://api.zenith.io/v1/classes/Todo?where={\"done\":false}&limit=10" \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***"
```

Response:

```json
{
  "results": [
    {
      "objectId": "abc123",
      "title": "Buy milk",
      "done": false,
      "createdAt": "2026-06-06T12:00:00.000Z",
      "updatedAt": "2026-06-06T12:00:00.000Z"
    }
  ]
}
```

## 4. Use the SDK (TypeScript)

```bash
npm install @zenith/sdk-typescript
```

```typescript
import { Zenith } from "@zenith/sdk-typescript";

const zenith = new Zenith({
  appId: "acme-corp-prod",
  apiKey: process.env.ZENITH_API_KEY!,
  region: "us-east-1",
});

const todo = await zenith.classes("Todo").create({
  title: "Buy milk",
  done: false,
});
console.log(todo.objectId);

const open = await zenith.classes("Todo").query({ done: false }).limit(10).find();
console.log(open.results);
```

## 5. Use the SDK (Python)

```bash
pip install zenith-sdk
```

```python
from zenith import Zenith

zenith = Zenith(
    app_id="acme-corp-prod",
    api_key=os.environ["ZENITH_API_KEY"],
    region="us-east-1",
)

todo = zenith.classes("Todo").create({"title": "Buy milk", "done": False})
print(todo["objectId"])

open_todos = zenith.classes("Todo").query(done=False).limit(10).find()
print(open_todos["results"])
```

## 6. Subscribe to real-time updates (WebSocket)

```typescript
import { Zenith } from "@zenith/sdk-typescript";

const zenith = new Zenith({ /* ... */ });

const live = zenith.liveQuery("Todo", { done: false });
live.on("create", (todo) => console.log("new todo:", todo));
live.on("update", (todo) => console.log("updated:", todo));
live.subscribe();
```

## 7. Next steps

- **Auth**: see `tutorials/02_user_auth.md`
- **File upload**: see `tutorials/03_files.md`
- **Cloud functions**: see `tutorials/04_cloud_functions.md`
- **Push notifications**: see `tutorials/05_push.md`
- **Real-time queries**: see `tutorials/06_live_queries.md`

## 8. Troubleshooting

| Error                       | Cause                                       | Fix                                   |
| --------------------------- | ------------------------------------------- | ------------------------------------- |
| `401 invalid session token` | Missing or wrong API key                    | Check `Authorization: Bearer` header  |
| `403 forbidden`             | Key lacks scope for this operation         | Re-issue with `data:write` scope      |
| `404 class does not exist`  | First write to a new class — schema is auto-created | Just retry; the class is created on first write |
| `429 rate limit exceeded`   | Exceeded the per-key rate limit             | Reduce request rate or upgrade plan   |
| `502 bad gateway`           | Backend pod restarting                      | Retry with exponential backoff        |
