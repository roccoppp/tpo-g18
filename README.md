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
| recetas     | MongoDB + copia en Neo4j | colección `recetas` (`_id` = id_receta); nodo `(:Receta)-[:EMITIDA_PARA]->(:Cliente)` |
| clientes    | MongoDB + copia en Neo4j | colección `clientes` (`_id` = id_cliente, índice único sobre `dni`); nodo `(:Cliente)` |
| ventas y detalle_ventas | MongoDB + copia en Neo4j | colección `ventas` (`_id` = id_venta, ítems embebidos en `items`); nodo `(:Venta)` con la cabecera, `-[:ATENDIDA_POR]->(:Farmaceutico)`, `-[:DE_CLIENTE]->(:Cliente)`, `-[:CON_RECETA]->(:Receta)` y un `-[:INCLUYE {id_detalle, cantidad, precio_unit}]->(:Producto)` por ítem |

MongoDB es la fuente de verdad de productos, lotes, clientes, recetas y ventas: la copia en Neo4j se escribe después. La colección `contadores` guarda el último número de id asignado a cada entidad, para las altas.

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
| 10  | Clientes atendidos en una sucursal (a través del farmacéutico, activo o no): `npm run query -- 10 <id_sucursal>` | `src/queries/q10.ts` |
| 11  | Ingresos totales por farmacéutico en el mes actual (solo 'Completada') | `src/queries/q11.ts` |
| 12  | Clientes sin ventas en el último año | `src/queries/q12.ts` |
| 13  | ABM de clientes: alta (DNI único), modificación de contacto y cobertura, baja lógica (ver abajo) | `src/queries/q13.ts` |
| 14  | Registro de una venta 'Completada' con validaciones, actualización de la receta y descuento de stock con q15 (ver abajo) | `src/queries/q14.ts` |
| 15  | Descuento de stock de una venta en los lotes de la sucursal (FEFO, sin vencidos, todo o nada): `npm run query -- 15 <id_venta>` | `src/queries/q15.ts` |

Uso de q13 (los campos van como `campo=valor`; un valor vacío, como `nro_afiliado=`, se toma como nulo):

```bash
npm run query -- 13 alta nombre=Valentina apellido=Sosa dni=41222333 email=vale.sosa@gmail.com \
  telefono=1145990011 ciudad="La Plata" provincia="Buenos Aires" obra_social=OSDE nro_afiliado=OS-412233
npm run query -- 13 modificar C019 email=valentina.sosa@outlook.com obra_social="Sin cobertura" nro_afiliado=
npm run query -- 13 baja C019
```

El alta recibe todos los campos menos el id, que se asigna solo (después de `npm run seed`, el primero es C019). La modificación acepta `email`, `telefono`, `obra_social` y `nro_afiliado`. Cada operación imprime el cliente antes y después. Si una validación no pasa, imprime `Rechazado: <motivo>` y termina con código 1.

Uso de q14 (cada ítem va como `id_producto:cantidad`; la receta, solo si algún producto la requiere):

```bash
npm run query -- 14 C001 F001 Efectivo PRD001:2 PRD011:1
npm run query -- 14 C003 F005 Débito receta=RC002 PRD008:1
```

La venta se registra con fecha de hoy, el precio de lista vigente de cada producto y el total calculado a partir de los ítems. Si tiene receta, registra la dispensa. En la misma transacción descuenta el stock con q15: si no alcanza para algún ítem, la venta se rechaza completa. Imprime la venta, la receta antes y después (si corresponde) y los lotes modificados. Si una validación no pasa, imprime `Rechazado: <motivo>` y no modifica ningún dato.

Uso de q15:

```bash
npm run query -- 15 V017
```

Descuenta las unidades de cada ítem de la venta en los lotes de la sucursal del farmacéutico que la atendió: primero el lote que vence antes, sin usar lotes vencidos. Solo se aplica a ventas 'Completada' y una sola vez por venta. Imprime cada lote modificado antes y después. Si el stock vigente no alcanza para algún ítem, imprime `Rechazado: <motivo>` y no modifica ningún lote.
