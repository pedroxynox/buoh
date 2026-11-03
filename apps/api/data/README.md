# Datos de la API

## `contrasenas-comunes.txt`

La lista de bloqueo de las contraseñas de buoh ([ADR-0019](../../../docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md) §1): una contraseña nueva que esté en ella, sin distinguir mayúsculas, se rechaza con `common_password`. Son 10 898 contraseñas, una por línea, en NFC y en minúsculas, únicas y ordenadas por unidades de UTF-16.

**Origen.** Las líneas de 15 a 128 caracteres, contados después de normalizarlas a NFC, de la lista de las un millón de contraseñas más comunes del conjunto de diez millones que Mark Burnett publicó en 2015 y cedió al dominio público, tal como la recoge SecLists:

- archivo: `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`;
- commit de SecLists: `68bcd12457978649d41ae4f56e3b5d2db2b72560` (el archivo cambió por última vez en `c205c36a445bff37f8e58a9ec829105cd4975c58`, del 2025-05-08);
- SHA-256 del archivo: `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51`;
- consultado el 2026-11-03.

La lista se vuelve a construir, sin abrir la red, desde una copia local de ese archivo, que no entra en Git:

```sh
pnpm --filter @buoh/api exec tsx scripts/build-common-passwords.ts <ruta de la copia>
```

El script comprueba el SHA-256 de la copia antes de escribir nada. Las pruebas de `test/password.test.ts` comprueban el formato de la lista y su número de líneas.

**Licencia.** SecLists se distribuye con esta licencia:

```text
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
