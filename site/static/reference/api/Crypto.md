# Crypto



## `POST /crypto/hash`
**Hash password with Argon2id**

### Body
```json
{
  "type": "object",
  "properties": {
    "password": {
      "type": "string"
    }
  },
  "required": [
    "password"
  ]
}
```

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /crypto/hmac`
**Sign message with HMAC-SHA256/512**

### Body
```json
{
  "type": "object",
  "properties": {
    "key": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "algorithm": {
      "type": "string",
      "enum": [
        "SHA-256",
        "SHA-512"
      ]
    }
  },
  "required": [
    "key",
    "message"
  ]
}
```

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---
