import Link from 'next/link';
import { PageHeader } from '../src/components/AppShell';

export default function NotFound() {
  return (
    <>
      <PageHeader
        eyebrow="404"
        title="Aquí no hay nada que observar"
        summary="La página no existe en este prototipo."
      />
      <p>
        <Link className="w-link" href="/">
          Volver al observatorio
        </Link>
      </p>
    </>
  );
}
