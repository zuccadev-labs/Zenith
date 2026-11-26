---
description: "Subir, descargar y borrar archivos con /files, y compartirlos con URLs firmadas que caducan."
tipo: guia
---

# ¿Cómo subo, sirvo y comparto archivos?

Con `/files/:filename`, la ruta de Parse Server, usando la master key. Para que alguien sin credenciales descargue
un archivo, el servidor genera una URL firmada que caduca.

## Requisitos

- La master key, desde localhost: las rutas de `/files` son `master`
  ([ADR-013](../investigations/adr/13-composition-and-access.md)).
- `FILE_SIGNING_KEY` en el entorno si vas a usar URLs firmadas. Sin ella, cada proceso inventa una clave aleatoria
  y avisa en el log: las URLs dejan de valer al reiniciar y no valen en otra réplica.

## Pasos

1. **Subir:** los bytes tal cual, con su `Content-Type`.

   ```bash
   curl -X POST http://localhost:1337/files/informe.pdf \
     -H "X-Parse-Application-Id: miapp" -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" \
     -H "Content-Type: application/pdf" --data-binary @informe.pdf
   ```

2. **Descargar:** `GET /files/informe.pdf`, con la master key.

3. **Compartir:** pide una URL firmada. `expiresIn` va en segundos, de 1 a 7 días; por defecto, una hora.

   ```bash
   curl "http://localhost:1337/zen/files/informe.pdf/url?expiresIn=86400" \
     -H "X-Parse-Application-Id: miapp" -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY"
   ```

   La URL apunta a `GET /files/:objectId/:filename?expires=…&sig=…`, que es pública. El tope de 7 días es el mismo
   que el de las URLs prefirmadas de S3 (SigV4).

4. **Borrar:** `DELETE /files/informe.pdf`, con la master key.

## Dónde se guardan

El contenido va al disco, en `ZENITH_FILES_DIR` (por defecto `./.zenith-storage`), con un nombre aleatorio. El
registro va a la clase `_File` de la base de datos. En varias réplicas, esa carpeta tiene que ser compartida.

El motor también compone un adaptador S3 para RustFS (pieza `objectStorage`), pero `/files` no lo usa hoy.

## Triggers

`Zen.Cloud.beforeSaveFile`, `afterSaveFile`, `beforeDeleteFile` y `afterDeleteFile` se ejecutan alrededor de la
subida y el borrado, como en Parse Server.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| 403 `{ "code": 119, "error": "Invalid or expired signed URL." }` | Firma inválida, URL caducada o archivo que no existe. La respuesta es la misma en los tres casos para que la URL no revele nada | Pedir otra URL |
| Las URLs firmadas dejan de valer al reiniciar | Falta `FILE_SIGNING_KEY` | Fijarla, igual en todas las réplicas |
| `ZenithFile.save()` falla desde el SDK de cliente | El SDK sube con la sesión del usuario y la ruta solo acepta la master key | Subir desde un backend de confianza, o exponer una función de Cloud Code que lo haga |

Lo último lo deduzco del código (`sdk/Typescript/src/objects/ZenithFile.ts` frente a
`zenith-backend/src/traits/storage/storage.trait.ts`); no lo he probado contra un servidor.

## Relacionado

- [Acceso y API keys](./04-acceso-y-api-keys.md).
- [Lo que falta](../development/10-lo-que-falta.md): abrir a usuarios las rutas que siguen siendo solo `master`,
  `/files` entre ellas, está pendiente trait por trait.
