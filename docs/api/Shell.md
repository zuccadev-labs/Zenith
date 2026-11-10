# Shell



## `POST /shell/exec`
**Execute a whitelisted shell command**

### Body
```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string"
    },
    "timeout": {
      "type": "integer"
    }
  },
  "required": [
    "command"
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

## `GET /shell/history`
**Get shell execution history**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---
