# Search

> Motor de búsqueda full-text con scoring de relevancia y filtros avanzados.

## `GET /zen/search`
**Full-text search global (CRM/ERP/Notes/Tasks)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `q` | query | string | — | Término de búsqueda |
| `types` | query | string | — | Tipos a buscar ej: Contact,Deal,Note |
| `limit` | query | integer | — | Máximo de resultados (default 20) |
| `filter` | query | string | — | FilterGroup JSON para filtros avanzados |
| `mode` | query | string | — | text|semantic (default: text) |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/search/suggest`
**Sugerencias de búsqueda (searchbox autocomplete)**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---
