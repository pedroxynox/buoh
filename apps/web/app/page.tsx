import dynamic from 'next/dynamic';
import { ObservatorioDesktop } from '../src/components/ObservatorioDesktop';

/**
 * Observatorio (concepto de interfaz §3). El escritorio lo dibuja con datos ficticios; la variante
 * servida por la API, con la salud real de los datos, que pide a la API (concepto de interfaz §10;
 * ADR-0019 §8). El empaquetador quita del escritorio el componente que llama a la API (`F2-UI-001`).
 */
const Observatorio =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() =>
        import('../src/components/ObservatorioReal').then((module) => module.ObservatorioReal),
      )
    : ObservatorioDesktop;

export default function ObservatorioPage() {
  return <Observatorio />;
}
