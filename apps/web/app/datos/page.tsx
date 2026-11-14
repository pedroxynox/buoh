import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { DatosDesktop } from '../../src/components/DatosDesktop';

/**
 * Datos (concepto de interfaz §3). El escritorio la dibuja con datos ficticios; la variante servida
 * por la API pide los datasets publicados reales (ADR-0020 §10; concepto de interfaz §14). El
 * empaquetador quita del escritorio el componente que llama a la API (`F2-UI-001`).
 */
export const metadata: Metadata = { title: 'Datos' };

const Datos =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() => import('../../src/components/DatosReal').then((module) => module.DatosReal))
    : DatosDesktop;

export default function DatosPage() {
  return <Datos />;
}
