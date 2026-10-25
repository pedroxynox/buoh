import { Card, PhaseLock } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';

export const metadata: Metadata = { title: 'Riesgo' };

const LIMITS = [
  ['Instrumentos permitidos', 'Lista explícita por estrategia y cuenta'],
  ['Monto máximo por operación', 'Fijo por política y entorno'],
  ['Exposición simultánea', 'Máximo de posiciones abiertas a la vez'],
  ['Pérdida por ventana', 'Corte automático al alcanzar el límite del día o la semana'],
  ['Frecuencia', 'Máximo de operaciones por minuto y por hora'],
  ['Antigüedad de la señal', 'Una señal vencida nunca se ejecuta'],
  ['Calidad de datos', 'Con datos degradados, la estrategia se pausa'],
  ['CFD en MT5', 'Tamaño, stop, margen, apalancamiento, spread y swap'],
] as const;

export default function RiesgoPage() {
  return (
    <>
      <PageHeader
        eyebrow="Riesgo"
        title="¿Qué límites protegen cada estrategia?"
        summary="Las políticas de riesgo son versionadas y se revisan antes de cualquier orden. Detener siempre está a mano; operar nunca desde una pantalla."
      />

      <PhaseLock
        phase="4"
        title="Políticas de riesgo y kill switch"
        description="Los valores concretos se fijan después de investigar; no se inventan aquí."
      />

      <Card title="Qué cubrirá una política" subtitle="Vista previa sin valores" headingLevel={2}>
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Límite</th>
                <th scope="col">Qué controla</th>
              </tr>
            </thead>
            <tbody>
              {LIMITS.map(([limit, description]) => (
                <tr key={limit}>
                  <td>
                    <strong>{limit}</strong>
                  </td>
                  <td className="b-secondary">{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Kill switch" subtitle="Global, por estrategia y por usuario" headingLevel={2}>
        <div className="w-kill">
          <p className="b-secondary w-small">
            Detendrá todo con un solo paso, desde cualquier plataforma, y quedará en la auditoría.
            Se probará de forma periódica.
          </p>
          <button className="b-button b-button--secondary" type="button" disabled>
            Detener todo · Fase 4
          </button>
        </div>
      </Card>
    </>
  );
}
