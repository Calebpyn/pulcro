# Funciones en pausa

Integración con Claude, retirada de Pulcro en la versión 0.1.1 para retomarla como feature futura.

- **`mcp/`**: servidor MCP (`mcp.js`) con las herramientas `system_health`, `scan_cleanup`, `space_breakdown`,
  `clean_items` y `get_history`, más `register-claude.sh` para registrarlo en Claude Code y Claude Desktop.
  Para reactivarlo: devolver `mcp.js` a `src/`, reinstalar `@modelcontextprotocol/sdk` y `zod`, y registrar
  `Pulcro.app/Contents/Resources/engine/src/mcp.js`.
- **`asistente/`**: chat con Claude dentro de la app (ver su README).

Cuando Claude actuaba por MCP, sus acciones quedaban en el historial con `actor: "claude"` y la app las mostraba en vivo;
la interfaz actual ya no distingue actores.
