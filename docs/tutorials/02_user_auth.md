# Tutorial 02 — User authentication

> **Goal:** sign up, log in, and protect a route with session tokens.

## 1. Sign up

```bash
curl https://api.zenith.io/v1/users \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "P@ssw0rd!",
    "email": "alice@example.com"
  }'
```

Response (201 Created):

```json
{
  "objectId": "usr_abc",
  "username": "alice",
  "sessionToken": "r:abc123...",
  "createdAt": "2026-06-06T12:00:00.000Z"
}
```

Save the `sessionToken` in a secure cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).

## 2. Log in

```bash
curl https://api.zenith.io/v1/login \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: application/json" \
  -d '{ "username": "alice", "password": "P@ssw0rd!" }'
```

Response (200 OK):

```json
{
  "objectId": "usr_abc",
  "username": "alice",
  "sessionToken": "r:def456..."
}
```

## 3. Use the session token

```bash
curl https://api.zenith.io/v1/users/me \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "X-Parse-Session-Token: r:def456..."
```

Response (200 OK):

```json
{
  "objectId": "usr_abc",
  "username": "alice",
  "email": "alice@example.com"
}
```

## 4. Log out

```bash
curl -X POST https://api.zenith.io/v1/logout \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "X-Parse-Session-Token: r:def456..."
```

## 5. Password reset

### Request

```bash
curl -X POST https://api.zenith.io/v1/requestPasswordReset \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: application/json" \
  -d '{ "email": "alice@example.com" }'
```

The user receives an email with a reset link containing a one-time token.

### Confirm

```bash
curl -X POST https://api.zenith.io/v1/users \
  -H "X-Parse-Application-Id: acme-corp-prod" \
  -H "Authorization: Bearer sk_live_***" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "NewP@ssw0rd!",
    "sessionToken": "<reset-token-from-email>"
  }'
```

## 6. SDK examples

### TypeScript

```typescript
const user = await zenith.users.signup({
  username: "alice",
  password: "P@ssw0rd!",
  email: "alice@example.com",
});
zenith.setSessionToken(user.sessionToken);

const me = await zenith.users.me();
console.log(me.username);

await zenith.users.logout();
```

### Python

```python
user = zenith.users.signup({
    "username": "alice",
    "password": "P@ssw0rd!",
    "email": "alice@example.com",
})
zenith.set_session_token(user["sessionToken"])

me = zenith.users.me()
print(me["username"])

zenith.users.logout()
```

## 7. Security notes

- Passwords are hashed with **Argon2id** (`m=64 MB, t=3, p=4`).
- Session tokens are revocable; calling `/logout` invalidates them server-side.
- Sessions auto-expire after 30 days of inactivity.
- MFA can be enforced per-tenant (admin setting).
- Failed login attempts are rate-limited: 10 / min per IP, 60 / min per username.
