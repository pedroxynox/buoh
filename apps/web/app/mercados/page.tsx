import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { MercadosDesktop } from '../../src/components/MercadosDesktop';

/**
 * Mercados (concepto de interfaz §3). El escritorio la dibuja con datos ficticios; la variante
 * servida por la API, con el gráfico de R_100 y el catálogo de Deriv reales, que pide a la API
 * (concepto de interfaz §11; ADR-0019 §8). El empaquetador quita del escritorio el componente que
 * llama a la API (`F2-UI-001`).
 */
export const metadata: Metadata = { title: 'Mercados' };

const Mercados =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() =>
        import('../../src/components/MercadosReal').then((module) => module.MercadosReal),
      )
    : MercadosDesktop;

export default function MercadosPage() {
  return <Mercados />;
}
