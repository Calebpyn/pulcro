# Asistente (en pausa)

Chat con Claude dentro de Pulcro. Quitado de la app el 2026-09-30 para retomarlo como feature futura.

**Cómo funcionaba:** `POST /api/ask` lanzaba `claude -p` (Claude Code CLI) con el MCP de Pulcro y solo
herramientas de lectura (`clean_items` bloqueado), y devolvía la respuesta en streaming (SSE). Claude terminaba
con `PULCRO_SUGERENCIAS: ["id", ...]` y la app mostraba un botón "Revisar y limpiar" con confirmación.

**Archivos** (copias completas de cuando existía la función): `server.js` (función `ask` + `ASSISTANT_PROMPT`),
`app.js` (sección "asistente": `sendPrompt`, `md`, `renderSuggestion`), `index.html` (`#view-assistant` + botón
del nav), `styles.css` (bloque "asistente"), `menu.html` / `menu.js` (botón Asistente del panel).

**Pendiente al retomarlo:** el CLI necesita sesión activa (`claude` → `/login`); considerar la API directa en
lugar del CLI para no depender de él.
