import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { AuditoriaDesktop } from '../../src/components/AuditoriaDesktop';

/**
 * Auditoría (concepto de interfaz §3). El escritorio la dibuja con datos ficticios; la variante
 * servida por la API pide los eventos reales de la cuenta (ADR-0019 §5 y §9). El empaquetador quita
 * del escritorio el componente que llama a la API (`F2-UI-001`).
 */
export const metadata: Metadata = { title: 'Auditoría' };

const Auditoria =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() =>
        import('../../src/components/AuditoriaReal').then((module) => module.AuditoriaReal),
      )
    : AuditoriaDesktop;

export default function AuditoriaPage() {
  return <Auditoria />;
}
