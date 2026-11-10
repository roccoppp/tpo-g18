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
| farmaceuticos | Neo4j                  | nodo `(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)`                                |
| recetas     | MongoDB                  | colección `recetas` (`_id` = id_receta)                                          |
| clientes    | MongoDB + copia en Neo4j | colección `clientes` (`_id` = id_cliente, índice único sobre `dni`); nodo `(:Cliente)` |
| ventas y detalle_ventas | MongoDB + copia en Neo4j | colección `ventas` (`_id` = id_venta, ítems embebidos en `items`); nodo `(:Venta)-[:ATENDIDA_POR]->(:Farmaceutico)` con la cabecera |

MongoDB es la fuente de verdad de productos, lotes, clientes y ventas: la copia en Neo4j se escribe después. La colección `contadores` guarda el último número de id asignado a cada entidad, para las altas.

## Reconstruir las copias de Neo4j

```bash
npm run sync
```

Si una escritura queda confirmada en MongoDB pero falla al actualizar su copia en Neo4j (el servicio lo avisa), `npm run sync` reescribe las copias desde MongoDB. A diferencia de `npm run seed`, no vuelve a los CSV: conserva lo que escribieron los servicios.

## Estructura del código

```text
src/
  <dominio>/           una carpeta por entidad (productos, proveedores, ...)
    types.ts           tipos del dominio
    repository.ts      clase que recibe el motor que usa (Db de MongoDB y/o driver de Neo4j)
                       y expone las operaciones que necesitan las consultas
  queries/qNN.ts       una función por consulta; recibe los repositorios que usa
  lib/                 conexión a los motores, lectura de CSV y armado de repositorios
scripts/               puntos de entrada: check, seed, sync y query
```

## Ejecutar las consultas

```bash
npm run query -- <número> [parámetros...]
```

| #   | Consulta                                          | Módulo               |
| --- | ------------------------------------------------- | -------------------- |
| 1   | Productos activos con todos los datos de su proveedor | `src/queries/q01.ts` |
| 2   | Ventas 'Pendiente' con farmacéutico (nombre, matrícula y sucursal) y total | `src/queries/q02.ts` |
| 3   | Historial de un cliente, ventas y recetas por fecha: `npm run query -- 3 <id_cliente>` | `src/queries/q03.ts` |
| 4   | Clientes con más de una receta registrada, con la cantidad | `src/queries/q04.ts` |
| 5   | Farmacéuticos activos y cantidad de ventas de los últimos 60 días (sin anuladas, incluye ceros) | `src/queries/q05.ts` |
| 6   | Recetas de tratamiento prolongado 'Vigente' con próxima dispensa anterior a hoy, con datos del cliente | `src/queries/q06.ts` |
| 7   | Top 5 productos más vendidos en unidades (solo ventas 'Completada') | `src/queries/q07.ts` |
| 8   | Lotes con menos de 50 unidades, con producto, sucursal y proveedor | `src/queries/q08.ts` |
| 9   | Ventas 'Venta libre' con total menor a $5.000 (sin anuladas) | `src/queries/q09.ts` |
| 13  | ABM de clientes: alta (DNI único), modificación de contacto y cobertura, baja lógica (ver abajo) | `src/queries/q13.ts` |

Uso de q13 (los campos van como `campo=valor`; un valor vacío, como `nro_afiliado=`, se toma como nulo):

```bash
npm run query -- 13 alta nombre=Valentina apellido=Sosa dni=41222333 email=vale.sosa@gmail.com \
  telefono=1145990011 ciudad="La Plata" provincia="Buenos Aires" obra_social=OSDE nro_afiliado=OS-412233
npm run query -- 13 modificar C009 email=valentina.sosa@outlook.com obra_social="Sin cobertura" nro_afiliado=
npm run query -- 13 baja C009
```

El alta recibe todos los campos menos el id, que se asigna solo. La modificación acepta `email`, `telefono`, `obra_social` y `nro_afiliado`. Cada operación imprime el cliente antes y después. Si una validación no pasa, imprime `Rechazado: <motivo>` y termina con código 1.
