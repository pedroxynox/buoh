# ADR-0006: Alojamiento productivo en Render

- **Estado:** Aceptada
- **Fecha:** 2026-10-23
- **Ámbito:** Despliegue posterior a Fase 1
- **Decisores:** Propietario de buoh

## Contexto

El plan de Fase 1 difiere el despliegue productivo y exige que el diseño sea portable a Render y a almacenamiento S3-compatible (§4 y §10). El propietario confirmó el destino de la base de datos, la API y la web; la aplicación móvil queda sin decidir.

Render ofrece PostgreSQL gestionado, servicios web y background workers. Sus servicios tienen sistema de archivos efímero salvo que se les monte un disco persistente, y no ofrece almacenamiento de objetos S3-compatible propio; su documentación remite a un proveedor S3 externo para archivos compartidos.

## Decisión

- **PostgreSQL:** Render Postgres.
- **API** (`apps/api`, Fastify) y **web** (`apps/web`, Next.js): servicios web de Render.
- **`market-data-worker`:** background worker de Render, cuando se despliegue.
- **Almacenamiento de objetos:** proveedor S3-compatible externo, todavía por elegir. Render no lo cubre.
- **App móvil:** se distribuye por las tiendas de Android e iOS y habla con la API alojada en Render. El servicio de compilación y distribución está por decidir.

Esta ADR no autoriza a desplegar ni a crear `apps/api`, `apps/web`, `apps/mobile` o `render.yaml` en Fase 1: siguen diferidos por el plan.

## Consecuencias

- El worker no puede confiar su durabilidad al disco local. El log raw-first de [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) ya escribe solo en PostgreSQL y en almacenamiento S3-compatible.
- La configuración y los secretos llegan por variables de entorno `BUOH_*`, que Render gestiona por servicio.
- Antes de desplegar hay que decidir el proveedor S3 productivo y la región, y separar en PostgreSQL un rol dueño de las tablas de un rol de ejecución que solo pueda insertar y leer.

## Referencias verificadas

- [Render: discos persistentes y sistema de archivos efímero](https://render.com/docs/disks)
- [Render: tipos de servicio, incluidos background workers](https://render.com/docs/service-types)
- [Render: solicitud abierta de almacenamiento de objetos propio](https://feedback.render.com/features/p/cloud-object-storage)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
