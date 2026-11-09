# tpo-g18

Backoffice de una red de farmacias con persistencia políglota: MongoDB y Neo4j, sobre TypeScript.

## Levantar el entorno

1. En GitHub, abrí este repositorio y andá a **Code → Codespaces → Create codespace on main**.
2. Esperá a que termine la configuración. Codespaces levanta MongoDB y Neo4j, instala las dependencias y ejecuta `npm run check`.
3. Para repetir la verificación, ejecutá:

   ```bash
   npm run check
   ```

   El resultado esperado es:

   ```text
   MongoDB OK (replica set rs0)
   Transacciones OK (rollback verificado)
   Neo4j OK (Neo4j/5.26.33)
   ```

Si cambiás `.devcontainer/`, ejecutá **Codespaces: Rebuild Container** desde la paleta de comandos.

## Cargar los datos

```bash
npm run seed
```

Carga los CSV de `data/provistos/` y, si existen, los registros adicionales de `data/adicionales/` (mismo nombre de archivo). Es idempotente: borra y vuelve a cargar cada entidad, así que se puede ejecutar cuantas veces se quiera. Antes de escribir valida tipos, ids únicos y referencias entre entidades.

| Entidad     | Motor                    | Estructura                                                                       |
| ----------- | ------------------------ | -------------------------------------------------------------------------------- |
| proveedores | Neo4j                    | nodo `(:Proveedor)`                                                              |
| sucursales  | Neo4j                    | nodo `(:Sucursal)`                                                               |
| productos   | MongoDB + copia en Neo4j | colección `productos` (`_id` = id_producto); nodo `(:Producto)-[:PROVISTO_POR]->(:Proveedor)` |
| stock_lotes | MongoDB + copia en Neo4j | colección `lotes` (`_id` = id_lote); nodo `(:Lote)` con `-[:DE_PRODUCTO]->(:Producto)` y `-[:EN_SUCURSAL]->(:Sucursal)` |

MongoDB es la fuente de verdad de productos y lotes: la copia en Neo4j se escribe después y se reconstruye volviendo a ejecutar la carga.

## Estructura del código

```text
src/
  <dominio>/           una carpeta por entidad (productos, proveedores, ...)
    types.ts           tipos del dominio
    repository.ts      clase que recibe el motor que usa (Db de MongoDB y/o driver de Neo4j)
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
| 8   | Lotes con menos de 50 unidades, con producto, sucursal y proveedor | `src/queries/q08.ts` |
