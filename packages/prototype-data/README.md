# @buoh/prototype-data

Datos ficticios de los prototipos de buoh (web y móvil), con una historia coherente al 20 oct 2026, 14:32:05 UTC. No representan resultados reales. Nació al separar los datos de `apps/web` para compartirlos con `apps/mobile` ([ADR-0009](../../docs/arquitectura/adr/0009-prototipo-movil.md)).

Las pruebas comprueban que la historia cuadra: salud frente a condiciones abiertas, estrategias aprobadas antes de emitir señales, pérdidas frente a muestras, la curva frente a su contexto y el hueco del gráfico frente a sus incidencias.

```text
pnpm --filter @buoh/prototype-data run test
```
