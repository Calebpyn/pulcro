# Pulcro

[![Licencia: AGPL-3.0](https://img.shields.io/badge/licencia-AGPL--3.0-blue.svg)](LICENSE)

Limpiador y monitor de salud para macOS, con estilo CleanMyMac. Libera espacio sin riesgo y te dice cómo está tu Mac.

<p align="center">
  <img src="docs/app.jpg" alt="Ventana principal de Pulcro" width="620" />
  &nbsp;
  <img src="docs/menu.jpg" alt="Panel de Pulcro en la barra de menús" width="190" />
</p>

## Qué hace

- **Resumen**: espacio libre, salud del SSD (S.M.A.R.T.), batería, memoria swap, días sin reiniciar y recomendaciones.
- **Limpieza**: encuentra lo que se puede borrar sin riesgo:
  - cachés de apps y logs
  - cachés de desarrollo: npm, pnpm, Homebrew, Gradle, Maven, NuGet, Cargo, Xcode, Android, Arduino
  - `node_modules`, `.next`, `target`, `.venv`… de tus proyectos, marcando los que llevan tiempo sin usarse
  - versiones viejas de extensiones de VS Code y Cursor
  - instaladores olvidados (`.dmg`, `.pkg`, `.iso`) y archivos de más de 1 GB
- **Espacio**: qué apps y carpetas pesan más. Desde aquí también vacías la Papelera.
- **Barra de menús**: panel con disco, memoria, CPU y batería en vivo, las apps que más memoria consumen y un botón para limpiar.
- **Historial**: cada escaneo y limpieza que has hecho, con el espacio liberado.

## Instalación

### Requisitos

- macOS 13 o superior (probado en macOS 26, Apple Silicon)
- [Node.js](https://nodejs.org) 20 o superior. Con Homebrew:

  ```bash
  brew install node
  ```

### Pasos

1. Descarga **`Pulcro-x.y.z.dmg`** desde [Releases](https://github.com/Calebpyn/pulcro/releases/latest).
2. Abre el DMG y arrastra **Pulcro** a **Aplicaciones**.
3. **La primera vez**, macOS la va a bloquear porque no está notarizada por Apple. Haz **clic derecho en Pulcro → Abrir → Abrir**. Solo se hace una vez.

   Si macOS dice que la app "está dañada", corre esto y vuelve a abrirla:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Pulcro.app
   ```

4. En el primer escaneo, macOS te pedirá permiso para que Pulcro lea **Escritorio, Documentos y Descargas**. Acepta, porque ahí busca tus proyectos.

### Uso diario

- Pulcro vive en la **barra de menús** (✨). Clic izquierdo abre el panel; clic derecho, el menú rápido (abrir, iniciar con la sesión, salir).
- Si cierras la ventana, Pulcro sigue en la barra de menús. **Cmd+Q** la cierra por completo.
- Activa **"Abrir al iniciar sesión"** desde el clic derecho para que arranque sola al prender la Mac.

## Seguridad

- Lo **seguro**, que se regenera solo, se borra. Lo **a revisar** va a la Papelera y lo puedes recuperar.
- Antes de tocar cualquier cosa, Pulcro vuelve a validar cada ID contra sus reglas ([`src/core/rules.js`](src/core/rules.js)). Solo acepta rutas canónicas, sin enlaces simbólicos, dentro de tu usuario y del tipo correcto.
- Keychains, iCloud, Mail, Mensajes, Fotos, `.ssh` y los contenedores de apps están protegidos.
- El motor solo escucha en `127.0.0.1` y rechaza peticiones de otros sitios.
- La Papelera solo se vacía cuando tú lo confirmas.

## Desarrollo

```bash
npm install
npm start            # interfaz en http://127.0.0.1:4747
npm run build:app    # compila ~/Applications/Pulcro.app (motor incluido)
npm run build:dmg    # genera dist/Pulcro-<versión>.dmg
```

Para compilar la app nativa se necesitan las Command Line Tools de Xcode:

```bash
xcode-select --install
```

### Estructura

```
src/core/     motor: salud, escaneo, reglas de seguridad, limpieza, historial, métricas en vivo
src/server.js servidor local (API + eventos en vivo)
public/       interfaz (ventana principal y panel de la barra de menús)
macos/        app nativa en Swift (ventana + barra de menús)
scripts/      compilación de la app y del DMG
future/       funciones en pausa (integración con Claude)
```

Para agregar carpetas de proyectos, crea `~/Library/Application Support/Pulcro/config.json`:

```json
{ "projectRoots": ["~/Code", "~/Work"] }
```

## Licencia

Pulcro es software libre bajo la licencia [GNU AGPL-3.0](LICENSE). En palabras simples:

- Puedes usarlo gratis en todas tus Macs.
- Puedes modificarlo y compartirlo.
- Si distribuyes una versión modificada, **o la ofreces como servicio a otros por internet**, tienes que publicar tu código bajo la misma licencia.

Lo último es a propósito: evita que alguien tome Pulcro, lo cierre y lo venda como otro limpiador de suscripción.

Copyright © 2026 Alonso Payán y colaboradores.
