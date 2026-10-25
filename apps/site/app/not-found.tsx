import Link from 'next/link';
import { PageIntro } from '../src/Frame';

export default function NotFound() {
  return (
    <>
      <PageIntro
        eyebrow="404"
        title="Aquí no hay nada que observar"
        summary="La página que buscas no existe."
      />
      <div className="s-container s-more">
        <Link className="s-link" href="/">
          Volver al inicio
        </Link>
      </div>
    </>
  );
}
