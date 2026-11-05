'use client';

import { FictitiousDataNotice } from '@buoh/design-system/react';
import { usePathname } from 'next/navigation';
import { showsFictitiousDataInApi } from '../navigation';

/**
 * La marca «Datos ficticios» de la barra superior en la web servida por la API: solo en las secciones
 * que siguen con datos ficticios, no en las que muestran datos reales ni en las pantallas sin datos
 * (concepto de interfaz §2; plan de Fase 2, `F2-UI-001`). Necesita la ruta actual, como `NavLink`. El
 * escritorio la muestra siempre, sin este componente.
 */
export function FictitiousDataMark() {
  return showsFictitiousDataInApi(usePathname()) ? <FictitiousDataNotice /> : null;
}
