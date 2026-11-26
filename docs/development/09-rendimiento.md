---
description: "Qué se ha medido del rendimiento de Zenith (nada todavía), los scripts de k6 que hay y lo que les falta."
tipo: guia
---

# ¿Qué se ha medido del rendimiento?

Nada todavía. Hay escenarios de carga con k6 en `zenith-backend/tests/load/`, pero no los he ejecutado contra un
despliegue que sirva de referencia, así que no publico cifras. El plan original, con objetivos de latencia que
nunca se midieron, está en el [archivo](./archivo/08-plan-de-rendimiento-original.md).

Lo único medido bajo carga es la corrección, no la velocidad: la prueba de estrés de la cola y los webhooks
([Pruebas](./02-pruebas.md#carga-y-fallos)) comprueba que cada trabajo y cada mensaje se procesan exactamente una
vez con varias instancias y MongoDB pausado.

## Requisitos

- k6.
- Un servidor Zenith con MongoDB. Los escenarios usan la master key, que solo vale desde localhost: k6 tiene que
  correr en la misma máquina o en el mismo pod.
- Para `auth.js`, engine-auth configurado ([Usuarios y sesiones](../users/02-usuarios-y-sesiones.md)).

## Pasos

```bash
cd zenith-backend
k6 run -e ZENITH_URL=http://localhost:1337 -e ZENITH_APP_ID=<appId> -e ZENITH_MASTER_KEY=<master key> \
  tests/load/scenarios/crud.js
```

| Escenario | Qué hace | Estado |
|---|---|---|
| `scenarios/crud.js` | Ciclo CRUD completo por usuario virtual sobre `/classes` | Las rutas existen |
| `scenarios/auth.js` | Registro, `/users/me`, logout y login | Necesita engine-auth |
| `scenarios/mixed.js` | Mezcla de autenticación y CRUD a ritmo constante | Necesita engine-auth |
| `scenarios/push.js` | Registro de instalaciones y push a un canal | No funciona: `/installations`, `/push` y `/push_audiences` no existen |

Los valores por defecto de los scripts (`http://localhost:8080`, `loadtest-master-key`) no son los de un proyecto
creado con `zen init`; hay que pasarlos siempre.

## Lo que no he comprobado

Ningún escenario. Una cifra sin su entorno (máquina, versión de MongoDB, piezas encendidas) no sirve para comparar;
la primera que se publique irá con él.
