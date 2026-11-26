# Timeline

> Feed de actividad inmutable por record: quién hizo qué y cuándo.

## `GET /zen/timeline/{className}/{objectId}`
**Timeline unificado de un record (Notes/Tasks/Comments/Attachments/Activities)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |
| `objectId` | path | string | ✅ |  |
| `limit` | query | integer | — |  |
| `skip` | query | integer | — |  |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---
