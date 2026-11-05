# tpo-g18

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

```bash
npm run seed
```

Carga los CSV de `data/provistos/` y, si existen, los registros adicionales de `data/adicionales/` (mismo nombre de archivo). Es idempotente: borra y vuelve a cargar cada entidad, así que se puede ejecutar cuantas veces se quiera. Antes de escribir valida tipos, ids únicos y referencias entre entidades.

| Entidad     | Motor   | Estructura                                  |
| ----------- | ------- | ------------------------------------------- |
| proveedores | Redis   | hash `proveedor:<id_proveedor>`             |
| productos   | MongoDB | colección `productos` (`_id` = id_producto) |

## Estructura del código

```text
src/
  <dominio>/           una carpeta por entidad (productos, proveedores, ...)
    types.ts           tipos del dominio
    repository.ts      clase que recibe el motor que usa (Db de MongoDB y/o cliente de Redis)
                       y expone las operaciones que necesitan las consultas
  queries/qNN.ts       una función por consulta; recibe los repositorios que usa
  lib/                 conexión a los motores, lectura de CSV y armado de repositorios
scripts/               puntos de entrada: check, seed y query
```

## Ejecutar las consultas

```bash
npm run query -- <número> [parámetros...]
```

| #   | Consulta                                          | Módulo               |
| --- | ------------------------------------------------- | -------------------- |
| 1   | Productos activos con todos los datos de su proveedor | `src/queries/q01.ts` |
