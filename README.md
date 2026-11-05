# FarmaRed

Backoffice de una red de farmacias con persistencia políglota: MongoDB y Redis, sobre TypeScript.

## Levantar el entorno

1. En GitHub, abrí este repositorio y andá a **Code → Codespaces → Create codespace on main**.
2. Esperá a que termine la configuración. Codespaces levanta MongoDB y Redis, instala las dependencias y ejecuta `npm run check`.
3. Para repetir la verificación, ejecutá:

   ```bash
   npm run check
   ```

   El resultado esperado es:

   ```text
   MongoDB OK (replica set rs0)
   Transacciones OK (rollback verificado)
   Redis OK (PONG)
   ```

Si cambiás `.devcontainer/`, ejecutá **Codespaces: Rebuild Container** desde la paleta de comandos.

## Cargar los datos

Pendiente.

## Ejecutar las consultas

Pendiente.
