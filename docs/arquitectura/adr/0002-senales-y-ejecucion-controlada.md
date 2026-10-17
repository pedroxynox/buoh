# ADR-0002: Señales y ejecución controlada

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Decisores:** Dirección técnica de buoh
- **Sustituye parcialmente:** ADR-0001, decisión 5 (alcance solo de observación)

## Contexto

La dirección de producto de buoh se aclara: no será únicamente un laboratorio. Será un bot de trading que investiga estrategias, ofrece señales y, tras validación, puede ejecutar operaciones autorizadas mediante Deriv. Esto incrementa de forma sustancial los requisitos de fiabilidad, seguridad, operación y cumplimiento.

La ejecución directa desde interfaz, una estrategia no validada o un servicio sin reconciliación producirían un riesgo inaceptable. También sería incorrecto convertir la meta de rentabilidad en una promesa de resultado.

## Decisión

1. buoh incluirá tres planos independientes: **investigación**, **señales** y **ejecución**.
2. El MVP comercial/técnico será un bot de señales `shadow`. La ejecución progresa obligatoriamente por `shadow` → `demo` → `real controlado`.
3. Solo un `execution-gateway` desplegado en servidor puede comunicarse con las operaciones autenticadas de Deriv. Web, móvil, overlay y motor de estrategias no pueden hacerlo directamente.
4. La pasarela exige autorización vigente, versión apta de estrategia, política de riesgo, datos saludables, clave de idempotencia, libro de auditoría y *kill switch* inactivo antes de enviar una intención.
5. Cada resultado se reconcilia con el estado de Deriv. Una respuesta ambigua bloquea el reintento automático hasta consultar el estado externo.
6. Las credenciales se manejan mediante OAuth 2.0 Authorization Code + PKCE, intercambio de código en backend, cifrado, rotación y revocación. No se aceptan contraseñas.
7. La rentabilidad se tratará como una hipótesis medida en contexto, jamás como garantía. Toda métrica debe identificar modo, período, costes, muestra, *drawdown*, versión y limitaciones.
8. Android e iOS son clientes de observación, control y autorización segura. iOS no depende de una superposición global; una capa Android opcional no tiene facultad de ejecución.
9. El producto no gestionará fondos, depósitos, retiros ni custodia. El lanzamiento comercial y de dinero real queda condicionado a evaluación legal/de cumplimiento según jurisdicción, público y condiciones de Deriv.
10. buoh se valida primero para uso propio y evoluciona a suscriptores externos; las señales pagas y la ejecución real son objetivos explícitos del producto. Las puertas de lanzamiento limitan cuándo y dónde se habilitan, no su existencia.

## Consecuencias positivas

- La intención original de construir un bot se preserva sin convertir una pantalla o una señal en una orden accidental.
- Las fallas de datos, red, lógica o proveedor pueden aislarse, auditarse y detenerse.
- La evidencia de una señal o una operación puede rastrearse desde datos crudos hasta la respuesta de la plataforma.
- La app iOS y la futura Windows comparten producto sin recibir secretos o permisos de ejecución.
- La revisión de desempeño puede distinguir resultados históricos, *shadow*, demo y reales.

## Costes y compromisos aceptados

- Se requieren más servicios, pruebas de integración, monitorización y respuesta a incidentes que en una app de señales únicamente.
- La primera ruta de ejecución será demo, aunque la meta final incluya dinero real.
- El producto necesita decisiones externas antes de comercializar o ejecutar: jurisdicción, entidad, modelo de clientes y validación de cumplimiento.
- La pasarela de ejecución y las políticas de riesgo requieren revisión independiente y pruebas de fallos, no solo cobertura de código.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Mantener buoh solo como laboratorio | No cumple la dirección de producto aclarada. |
| Operar directamente desde web o móvil | Expone credenciales, evita controles centralizados y dificulta auditoría/reconciliación. |
| Saltar de *backtest* a dinero real | No mide deriva en vivo ni robustez operativa. |
| Usar un único proceso para señales y ejecución | Un fallo o cambio de estrategia podría afectar el plano de órdenes. |
| Presentar "rentabilidad" como garantía | No es verificable ni compatible con comunicación responsable. |
| Guardar contraseñas o tokens en el cliente | Aumenta exposición y contradice el flujo delegado recomendado. |

## Condiciones de revisión

Revisar esta ADR si Deriv cambia los mecanismos de autenticación/ejecución, se añade otro bróker, cambia la jurisdicción, se introduce ejecución de instrumentos distintos, se habilita un modelo multiusuario comercial o la evidencia exige modificar el modelo de promoción.

## Referencias técnicas

- [Resumen de APIs de Deriv](https://developers.deriv.com/docs/intro/api-overview/)
- [Compra de contratos de Deriv](https://developers.deriv.com/docs/trading/buy/)
- [Canal demo de Deriv](https://developers.deriv.com/docs/options/ws-demo/)
- [OAuth 2.0 de Deriv](https://developers.deriv.com/docs/intro/oauth/)

El contenido de las fuentes externas fue reformulado para cumplir con las restricciones de licencia.
