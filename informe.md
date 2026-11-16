# FarmaRed: Sistema de Gestión de Red de Farmacias

**Base de Datos II · Trabajo Práctico Obligatorio · 2.º cuatrimestre 2026**

**Grupo:** 18

| Integrante       | Legajo |
| ---------------- | ------ |
| Rocco Perrone    | 65628  |
| Santiago Neumann | 65718  |
| Jonas Glaubart   | 65790  |
| Franco Pampuri   | 65552  |

**Repositorio:** https://github.com/roccoppp/tpo-g18

---

## Índice

1. Introducción
2. Arquitectura de persistencia políglota
3. Organización del código por tipos de dominio
4. Modelo de datos
5. Integridad referencial
6. Estrategia de carga de datos
7. Consultas y servicios
8. Consistencia en los servicios de escritura (q14 y q15)
9. Limitaciones, alternativas evaluadas y conclusiones

---

## 1. Introducción

FarmaRed S.A. es una red de farmacias. Hoy su backoffice funciona sobre planillas de cálculo.
Este trabajo migra esa gestión a una arquitectura de **persistencia políglota**: dos motores NoSQL
de paradigmas distintos, MongoDB (documental) y Neo4j (grafos), cada uno donde mejor resuelve el
problema, y una aplicación en TypeScript que los usa a través de repositorios por dominio.

El sistema gestiona proveedores, sucursales, productos, lotes de stock, clientes, farmacéuticos,
recetas y ventas con sus ítems. MongoDB es la base central: guarda las entidades que participan en
las escrituras que deben ser consistentes (ventas, recetas, stock y clientes). Neo4j guarda como grafo
las entidades que se consultan recorriendo relaciones, y es la única copia de los datos de referencia
que ningún servicio modifica (proveedores, sucursales y farmacéuticos).

El alcance del trabajo es:

- **15 consultas y servicios** (q01 a q15): 12 de lectura y 3 servicios de escritura (q13, ABM de
  clientes; q14, registro de una venta; q15, descuento de stock con FEFO), ejecutables con
  `npm run query -- <n>`.
- **Carga de datos** idempotente con `npm run seed`, a partir de los CSV provistos y de registros
  propios que ejercitan los casos borde (§6).
- **Entorno reproducible** en GitHub Codespaces, con MongoDB (replica set de un nodo, necesario para las
  transacciones) y Neo4j, verificable con `npm run check`.

El informe está organizado así: la arquitectura y la elección de cada motor (§2), la organización del
código (§3), el modelo de datos (§4), la integridad referencial (§5), la carga de datos (§6), las
consultas con ejemplos reales (§7), la consistencia de las escrituras (§8) y las limitaciones y
conclusiones (§9).

---

## 2. Arquitectura de persistencia políglota

### 2.1 Decisión

El sistema usa dos motores NoSQL de paradigmas distintos:

- **MongoDB (documental)** es la **base de datos central**. Guarda las entidades del negocio y es donde
  ocurren las escrituras que deben ser consistentes.
- **Neo4j (grafos)** es un **almacén complementario** que guarda las entidades como nodos y las
  referencias entre ellas como relaciones. Ahí se resuelven las consultas que recorren relaciones
  entre entidades.

```text
                    ┌─────────────────────────────┐
                    │   Aplicación (TypeScript)   │
                    │  consultas q01..q15, carga  │
                    └──────────────┬──────────────┘
                                   │ repositorios por dominio (§3)
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
   ┌───────────────────────────┐       ┌───────────────────────────┐
   │ MongoDB (base central)    │       │ Neo4j (grafo)             │
   │ entidades del negocio,    │       │ nodos y relaciones; las   │
   │ índices, agregaciones,    │       │ consultas recorren las    │
   │ transacciones multi-doc.  │       │ relaciones en el servidor │
   └───────────────────────────┘       └───────────────────────────┘
```

La asignación de cada entidad a un motor está en §2.4.

### 2.2 Por qué MongoDB es la base central

Elegimos el motor central según las características del negocio que pide considerar el enunciado (§3.2):

1. **Estructura jerárquica.** Una venta tiene una cabecera e ítems de cantidad variable. El modelo
   documental permite representar una estructura así en un único documento. Ese documento se lee y se
   escribe completo en una sola operación, sin reconstruirlo a partir de varias tablas o claves.
2. **Consultas por atributos.** Ventas, recetas y clientes se filtran por sus atributos: estado y rango
   de fechas (q07, q11), tipo y total (q09), tipo, estado y próxima dispensa (q06), DNI (q13). MongoDB
   admite índices secundarios, simples y compuestos, sobre cualquier campo. Un almacén clave-valor solo accede por clave: cada uno de esos criterios
   obligaría a mantener a mano un índice aparte.
3. **Reportes agregados.** Los totales por farmacéutico, los rankings de productos y los conteos por
   cliente (q04, q07, q11) se expresan como *aggregation pipelines* (`$match`, `$group`, `$sort`,
   `$lookup`). Se ejecutan en el servidor y solo devuelven el resultado. El conteo de ventas por
   farmacéutico de q05 se resuelve en Neo4j, porque tiene que incluir a los farmacéuticos sin ventas,
   que solo están en el grafo (§2.3).
4. **Consistencia en escrituras de varias entidades.** El servicio de registro de venta (q14) y el de
   descuento de stock (q15) tienen que funcionar juntos: si el descuento de stock falla, no puede quedar
   ni la venta registrada ni la receta modificada. MongoDB ofrece transacciones ACID sobre varios
   documentos y colecciones. Por eso guardamos en MongoDB todas las entidades que esas escrituras tocan
   (ventas, recetas, stock y clientes), y la operación se resuelve con una transacción en un único motor. Así no
   hay que coordinar dos motores que no comparten transacciones. Las transacciones requieren un
   *replica set*: el entorno levanta uno de un solo nodo (`rs0`) y `npm run check` verifica que una
   transacción abortada no deja datos.
5. **Actualizaciones concurrentes de stock.** Cada venta decrementa unidades de lotes. MongoDB permite
   actualizaciones atómicas condicionadas, por ejemplo `$inc` con un filtro que exige unidades
   suficientes. Dentro de una transacción, eso evita que el stock quede negativo aunque haya ventas
   concurrentes.
6. **Durabilidad.** La base central es la fuente de verdad, así que sus datos tienen que sobrevivir a
   un reinicio sin pérdidas. MongoDB confirma las escrituras contra un *journal* en disco.

### 2.3 Por qué Neo4j para recorrer relaciones

Muchas consultas devuelven una entidad junto con los datos de otras entidades relacionadas, y algunas
se definen directamente como un recorrido de relaciones:

- q01: producto con su proveedor.
- q02: venta con su farmacéutico y la sucursal del farmacéutico.
- q03: historial de un cliente: sus recetas y sus ventas, con los productos de cada venta.
- q05: farmacéuticos con la cantidad de ventas que atendieron, incluidos los que no atendieron ninguna.
- q08: lote con su producto, su sucursal y el proveedor del producto.
- q10: clientes de una sucursal, a través del farmacéutico que atendió la venta.
- q12: clientes que **no** tienen ventas en el último año.

En un modelo de grafos, cada referencia entre entidades (un producto y su proveedor, un lote y su
sucursal) es una relación con nombre propio. Para este tipo de consulta, Neo4j aporta:

1. **La consulta es el patrón de relaciones.** q08 se escribe como
   `(:Lote)-[:DE_PRODUCTO]->(:Producto)-[:PROVISTO_POR]->(:Proveedor)` más
   `(:Lote)-[:EN_SUCURSAL]->(:Sucursal)`. Los patrones opcionales (`OPTIONAL MATCH`, que cuenta los
   ceros de q05) y los negados (`NOT EXISTS`, para q12) se expresan igual de directo.
2. **La red cliente–receta–venta–producto está modelada como tal.** El enunciado (§3.2) describe
   estas relaciones como algo que se recorre en las consultas de historial. En el grafo cada una es
   una relación: `(:Receta)-[:EMITIDA_PARA]->(:Cliente)`, `(:Venta)-[:DE_CLIENTE]->(:Cliente)`,
   `(:Venta)-[:CON_RECETA]->(:Receta)` y `(:Venta)-[:INCLUYE]->(:Producto)`, con la cantidad y el
   precio de cada ítem como propiedades de la relación. q03 parte del cliente y sigue esas relaciones
   en un único patrón, que devuelve el historial ya ordenado, con la receta con la que se dispensó
   cada venta y el nombre de cada producto. Las mismas relaciones sirven para recorrer la red en otra
   dirección (por ejemplo, desde un producto hasta los clientes que lo compraron, o desde una receta
   hasta las ventas que la dispensaron) sin agregar índices ni colecciones.
3. **Las relaciones no quedan colgadas.** Una relación siempre une dos nodos que existen: no se puede
   crear hacia un nodo inexistente, y un nodo no se puede borrar sin borrar sus relaciones
   (`DETACH DELETE`). Además, la carga verifica que cada producto, lote, receta y venta haya quedado
   unido a sus nodos relacionados (§3.3, punto 6).
4. **Tipos nativos.** Neo4j guarda booleanos, enteros y fechas (`date`) como tales, así que, por
   ejemplo, el vencimiento de un lote se compara y se ordena como fecha dentro del grafo.

En cuanto al alcance: los recorridos de estas consultas son cortos y de profundidad fija (uno a tres
saltos), y con este volumen de datos llegar a cada vecino no es más rápido que una búsqueda por índice
en MongoDB, que también podría resolverlos con `$lookup` (§9.2). Elegimos Neo4j por los puntos 1 y 2:
cada consulta se escribe como el patrón de relaciones que describe, y la red que el enunciado pide
recorrer queda explícita en el modelo, en lugar de reconstruirse con uniones en cada consulta.

Esta decisión también fija qué **no** hace Neo4j:

- **No participa en las transacciones de q14 y q15.** Ventas, recetas y stock se escriben en MongoDB
  (§2.2, punto 4). Las entidades cuya fuente de verdad es MongoDB y que además se recorren en el
  grafo (productos, lotes, clientes, recetas y ventas) tienen en Neo4j una **copia**. La copia se escribe después de que
  MongoDB confirma la escritura y, si queda desfasada, se reconstruye desde MongoDB con `npm run sync`
  (§3.3, punto 3).
  Por ejemplo, q15 descuenta unidades de los lotes en MongoDB y después actualiza la copia, que es la
  que lee q08.
- **Guarda la única copia solo de los datos de referencia.** Proveedores, sucursales y
  farmacéuticos son datos de referencia: solo los escribe la carga, así que viven únicamente en Neo4j.
- **Los filtros y agregaciones que no recorren relaciones quedan en MongoDB** (q07, q09, q11), que
  los resuelve con índices y *aggregation pipelines* (§2.2, punto 3).

### 2.4 Asignación de entidades a motores

| Entidad        | Motor                    | Estructura                                                                                          | Justificación                                                                                                   | Estado       |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| proveedores    | Neo4j                    | nodo `(:Proveedor)`                                                                                 | Dato de referencia que ningún servicio escribe; se llega a él recorriendo relaciones (q01, q08)                 | Implementado |
| productos      | MongoDB + copia en Neo4j | colección `productos` (`_id` = id_producto); nodo `(:Producto)-[:PROVISTO_POR]->(:Proveedor)`       | MongoDB: q14 valida cada producto (existencia, estado activo y precio de lista vigente) junto con el resto de la venta, y q07 lo cruza con `$lookup`. Neo4j: q01, q03 y q08 recorren sus relaciones | Implementado |
| sucursales     | Neo4j                    | nodo `(:Sucursal)`                                                                                  | Dato de referencia que ningún servicio escribe; se llega a ella recorriendo relaciones (q02, q08, q10)          | Implementado |
| farmacéuticos  | Neo4j                    | nodo `(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)`                                                   | Dato de referencia que ningún servicio escribe; se llega a él recorriendo relaciones (q02)                      | Implementado |
| clientes       | MongoDB + copia en Neo4j | colección `clientes` (`_id` = id_cliente; índice único sobre `dni`); nodo `(:Cliente)`             | MongoDB: lo escribe un servicio (q13) y lo valida q14, así que no puede tener a Neo4j como única copia (§2.3); el índice único garantiza el DNI único. Neo4j: copia para las consultas que recorren las relaciones de los clientes (q03, q10, q12) | Implementado |
| recetas        | MongoDB + copia en Neo4j | colección `recetas` (`_id` = id_receta); nodo `(:Receta)-[:EMITIDA_PARA]->(:Cliente)`               | MongoDB: participa en la transacción de q14/q15 (§2.2, punto 4). Neo4j: q03 la recorre desde el cliente y desde sus ventas | Implementado |
| ventas/detalle | MongoDB + copia en Neo4j | colección `ventas` (`_id` = id_venta; ítems embebidos en `items`); nodo `(:Venta)` con la cabecera, `-[:ATENDIDA_POR]->(:Farmaceutico)`, `-[:DE_CLIENTE]->(:Cliente)`, `-[:CON_RECETA]->(:Receta)` y un `-[:INCLUYE]->(:Producto)` por ítem | MongoDB: estructura jerárquica + transacción de q14/q15 (§2.2). Neo4j: q02, q03, q05, q10 y q12 recorren sus relaciones | Implementado |
| stock_lotes    | MongoDB + copia en Neo4j | colección `lotes` (`_id` = id_lote); nodo `(:Lote)` con `DE_PRODUCTO` y `EN_SUCURSAL`               | MongoDB: actualizaciones concurrentes + transacción de q14/q15 (§2.2). Neo4j: q08 recorre sus relaciones        | Implementado |

---

## 3. Organización del código por tipos de dominio

### 3.1 Problema

Con persistencia políglota, una misma entidad puede estar guardada en más de un motor a la vez. Por
ejemplo, puede estar en MongoDB como fuente de verdad y en Neo4j como copia para recorrer sus
relaciones.
Ninguno de los dos motores garantiza integridad referencial, y no existe una transacción que abarque
a ambos. Si cualquier parte del código pudiera escribir directamente en cualquier motor, nada
garantizaría que las copias de una entidad coincidan, ni siquiera que tengan la misma forma.

### 3.2 Decisión

El código se organiza por **tipo de dominio** (una carpeta por entidad), no por motor:

```text
src/
  <dominio>/
    types.ts         tipo del dominio: la forma única de la entidad para toda la aplicación
    repository.ts    único punto de acceso a la entidad; recibe el/los motores que usa
  queries/qNN.ts     una función por consulta; recibe repositorios, nunca motores
  lib/
    repositorios.ts  arma un repositorio por dominio y le inyecta su motor
```

```text
  queries / scripts ──► repositorios por dominio ──► MongoDB / Neo4j
        (no conocen motores)   (único lugar que los conoce)
```

### 3.3 Cómo garantiza la consistencia

1. **Un único tipo por dominio.** `types.ts` define la entidad una sola vez. Todas sus
   representaciones (documento de MongoDB, nodo de Neo4j, fila de CSV) se convierten desde ese tipo y
   hacia él. El proyecto compila en modo `strict`, así que si se agrega un campo al tipo, las
   funciones de conversión que construyen la entidad dejan de compilar hasta que se actualizan. Las
   representaciones en cada motor no pueden divergir sin que el compilador lo detecte. Lo mismo vale
   para los valores enumerados (`TIPOS_PROVEEDOR`, `CONDICIONES_VENTA`): se definen una vez y los
   reusan tanto el tipo como la validación de la carga.
2. **Un único punto de acceso por dominio.** Solo el repositorio sabe en qué motor o motores vive la
   entidad, bajo qué clave o colección, y cómo se serializa. Las consultas y los scripts no reciben
   el cliente de MongoDB ni el driver de Neo4j: reciben repositorios. Por eso, cada escritura de una
   entidad pasa por exactamente un lugar del código.
3. **Escrituras coordinadas dentro del repositorio.** Si una entidad vive en los dos motores, el
   método del repositorio que la modifica escribe en ambos, siempre en el mismo orden. Primero va
   **MongoDB**, que es la fuente de verdad (§2.1), y después **Neo4j**, que es una copia derivada. Si
   falla la escritura en Neo4j, la copia se reconstruye desde MongoDB con `npm run sync`, que reescribe
   las copias sin tocar MongoDB. Nunca se reconstruye MongoDB a partir de Neo4j. Así lo hacen
   `ProductosRepository.reemplazarTodos`, `LotesRepository.reemplazarTodos`,
   `RecetasRepository.reemplazarTodas` y `VentasRepository.reemplazarTodas` en la carga, y
   `ClientesRepository.alta` y `ClientesRepository.actualizar` en un servicio (q13). En q14 y q15 la
   escritura en MongoDB forma parte de una transacción que abarca varias entidades, así que el
   repositorio la separa en dos métodos: uno escribe en MongoDB dentro de la transacción
   (`VentasRepository.registrar`, `RecetasRepository.dispensar`, `LotesRepository.descontarFefo`) y
   otro escribe la copia en Neo4j después de confirmarla (`VentasRepository.copiar`,
   `RecetasRepository.copiar`, `LotesRepository.copiarUnidades`). El orden se mantiene: primero
   MongoDB, después Neo4j (§8).
4. **Conversión en el borde.** Las diferencias de representación de cada motor se resuelven dentro
   del repositorio, y el resto de la aplicación no las ve. Por ejemplo:
   - En el grafo, las referencias no se guardan como propiedades: `producto.id_proveedor` es la
     relación `PROVISTO_POR`, y el repositorio reconstruye el campo a partir de ella al leer.
   - JavaScript no distingue enteros de decimales, así que el repositorio envía `unidades` y
     `precio_unit` como enteros de Neo4j. Si no lo hiciera, el grafo los guardaría como decimales.
   - El vencimiento de un lote se guarda como `date` de Neo4j y vuelve como `Date`.
5. **Atomicidad con la primitiva de cada motor.** Cada repositorio usa la garantía atómica de su
   motor: transacciones en Neo4j y operaciones sobre un documento o transacciones en MongoDB. Por
   ejemplo, el reemplazo de proveedores durante la carga borra los que ya no están y actualiza el
   resto en una única transacción de Neo4j: se aplica todo o nada.
6. **Referencias entre dominios validadas por la aplicación.** Cuando una entidad referencia a otra
   que vive en otro motor (`producto.id_proveedor` apunta a un nodo de Neo4j), la aplicación valida la
   referencia antes de escribir. Hoy lo hace la carga de datos, que comprueba ids únicos y referencias
   antes de tocar cualquier motor. Además, al escribir en el grafo productos, lotes, farmacéuticos,
   recetas y ventas, el repositorio cuenta las relaciones que creó: si alguna referencia no encontró su nodo, aborta la transacción de Neo4j y
   el grafo queda como estaba. Los servicios de escritura validan a través de los repositorios: q13
   lo hace con el de clientes, y q14 y q15 con los de clientes, farmacéuticos, productos, recetas,
   ventas y lotes (§7).

### 3.4 Costos de la decisión

- Las consultas que recorren relaciones se escriben como un único patrón de Cypher, dentro del
  repositorio de la entidad donde empieza el recorrido (q01 en productos, q02 en ventas, q03 en
  clientes, q08 en lotes). Ese repositorio usa los conversores de los otros dominios
  (`proveedorDesdeNodo`, `sucursalDesdeNodo`, `recetaDesdeNodo`, `ventaDesdeNodo`)
  para devolver cada entidad con su tipo.
- Cada entidad copiada en Neo4j suma una escritura más en cada servicio que la modifica. Por ejemplo,
  q15 tiene que actualizar las unidades de los lotes en el grafo después de confirmar su transacción
  en MongoDB.
- Cada repositorio expone operaciones a medida de las consultas que lo usan, no un CRUD genérico, así
  que una consulta nueva puede requerir un método nuevo en el repositorio.

### 3.5 Ejemplos

Los ejemplos siguientes salen del código del proyecto (`src/productos/repository.ts`).

**Un dominio guardado en los dos motores, y el orden de escritura.** Los productos viven en MongoDB
(fuente de verdad) y tienen una copia en Neo4j. El método que reemplaza el catálogo en la carga
escribe en ese orden:

```ts
async reemplazarTodos(productos: Producto[]): Promise<void> {
  await this.coleccion.deleteMany({});
  if (productos.length > 0) await this.coleccion.insertMany(productos);
  await this.copiarAlGrafo(productos);
}
```

Primero se escribe MongoDB y después la copia en Neo4j. Si falla el segundo paso, MongoDB ya quedó
escrito y la copia se reconstruye con `npm run sync` (`reconstruirCopia`), que lee los productos de
MongoDB y vuelve a escribir el grafo.

**Conversión en el borde.** El tipo `Producto` tiene `id_proveedor`, pero en el grafo ese dato no es una
propiedad: es la relación `PROVISTO_POR`. El repositorio hace la conversión en las dos direcciones, y
el resto de la aplicación solo ve el tipo `Producto`. Al escribir, `aNodo` arma las propiedades del
nodo y envía `precio_unit` como entero de Neo4j (JavaScript no distingue enteros de decimales):

```ts
function aNodo(producto: Producto) {
  return {
    id_producto: producto._id,
    nombre: producto.nombre,
    /* ... resto de las propiedades ... */
    precio_unit: neo4j.int(producto.precio_unit),
    activo: producto.activo,
  };
}
```

Al leer, `productoDesdeNodo` reconstruye `id_proveedor` a partir de la relación que recorrió la consulta:

```ts
export function productoDesdeNodo(nodo: Node, idProveedor: string): Producto {
  const p = nodo.properties;
  return {
    _id: p.id_producto,
    nombre: p.nombre,
    /* ... resto de las propiedades ... */
    id_proveedor: idProveedor,
    activo: p.activo,
  };
}
```

**Un campo nuevo en el tipo.** `productoDesdeNodo` declara que devuelve un `Producto`. Si se agrega un
campo obligatorio al tipo en `types.ts` (por ejemplo, `fabricante: string`) y no se agrega a la
conversión, TypeScript marca el `return` como error de compilación porque falta una propiedad
requerida (error TS2741). La diferencia entre el tipo y su conversión se detecta al compilar, antes
de ejecutar nada.

**Una escritura rechazada por una referencia inválida.** Al copiar los productos al grafo, la
consulta de Cypher crea cada relación `PROVISTO_POR` y devuelve cuántos productos encontraron su
proveedor. El repositorio compara ese número con la cantidad de productos que intentó escribir:

```ts
const relacionados: number = records[0].get("relacionados");
if (relacionados !== productos.length) {
  throw new Error(
    `Neo4j: solo ${relacionados} de ${productos.length} productos encontraron su proveedor`,
  );
}
```

Si un producto apunta a un proveedor que no existe, el error aborta la transacción de Neo4j y el
grafo queda como estaba: ningún producto queda sin su relación. En el uso normal esta situación no se
da, porque `npm run seed` ya validó antes todas las referencias (§5). Es una segunda barrera dentro
del repositorio.

---

## 4. Modelo de datos

Cada entidad vive en el motor que mejor sirve a las consultas y servicios que la usan (§2.4). Esta
sección describe cómo se modela en cada uno y cierra con un diagrama de conjunto.

### 4.1 MongoDB

| Colección | Forma del documento                                                                                                                                                  | Índices                             | Consultas |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------- |
| `ventas`  | `_id` (id_venta), `id_cliente`, `id_farmaceutico`, `id_receta` (`null` en ventas libres), `fecha`, `tipo`, `medio_pago`, `total`, `estado`, `items` embebidos (`id_detalle`, `id_producto`, `cantidad`, `precio_unit`) y `stock_descontado` (si q15 ya descontó su stock; la carga lo pone en `false`) | `{estado: 1, fecha: 1}` (q07, q11); `{tipo: 1, total: 1}` (q09) | q07, q09, q11, q14, q15 |
| `recetas` | `_id` (id_receta), `id_cliente`, `medico`, `matricula_medico`, `fecha_emision`, `tipo`, `dispensas_autorizadas`, `dispensas_realizadas`, `proxima_dispensa` (`null` si no corresponde), `estado` | `{tipo: 1, estado: 1, proxima_dispensa: 1}` (q06) | q04, q06, q14 |
| `clientes` | `_id` (id_cliente), `nombre`, `apellido`, `dni`, `email`, `telefono`, `ciudad`, `provincia`, `obra_social`, `nro_afiliado` (`null` si no tiene cobertura), `activo` y `version` (campo técnico de control de concurrencia: lo incrementa q14 dentro de su transacción, §8; no está hasta la primera venta registrada con q14, no forma parte del tipo `Cliente` y las lecturas lo excluyen) | `{dni: 1}` único | q04 y q06 (`$lookup`), q13, q14 |
| `lotes` | `_id` (id_lote), `id_producto`, `id_sucursal`, `nro_lote`, `unidades` (nunca negativas), `vencimiento` | `{id_sucursal: 1, id_producto: 1, vencimiento: 1}` (q15: lotes de una sucursal y un producto, en orden de vencimiento) | q14, q15 |
| `productos` | `_id` (id_producto), `nombre`, `principio_activo`, `categoria`, `presentacion`, `condicion_venta`, `precio_unit`, `id_proveedor`, `activo` | (solo `_id`) | q07 (`$lookup`), q14 |
| `contadores` | `_id` (nombre del contador: `clientes`, `ventas` o `detalle_ventas`), `ultimo` (último número de id asignado) | (solo `_id`) | q13 (id de cada alta de cliente), q14 (id de cada venta y de cada ítem) |

Los ítems de cada venta van embebidos porque se leen y se escriben junto con su cabecera (§2.2, punto 1).

Las unidades de los lotes se descuentan en MongoDB, dentro de la transacción de q14 y q15 (§8); el
nodo `(:Lote)` de Neo4j es una copia que se actualiza después de confirmarla.

### 4.2 Neo4j

Relaciones del grafo:

```text
(:Producto)-[:PROVISTO_POR]->(:Proveedor)      q01, q08
(:Lote)-[:DE_PRODUCTO]->(:Producto)            q08
(:Lote)-[:EN_SUCURSAL]->(:Sucursal)            q08
(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)     q02, q05, q10, q11, q14, q15
(:Venta)-[:ATENDIDA_POR]->(:Farmaceutico)      q02, q03, q05, q10
(:Venta)-[:DE_CLIENTE]->(:Cliente)             q03, q10, q12
(:Venta)-[:CON_RECETA]->(:Receta)              q03
(:Venta)-[:INCLUYE]->(:Producto)               q03 (un ítem: id_detalle, cantidad, precio_unit)
(:Receta)-[:EMITIDA_PARA]->(:Cliente)          q03
```

| Etiqueta    | Propiedades                                                                                          | Restricciones e índices                       | Origen                       |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| `Proveedor` | id_proveedor, razon_social, cuit, tipo, ciudad, provincia, telefono, activo                          | `id_proveedor` único                          | Única copia                  |
| `Sucursal`  | id_sucursal, nombre, tipo, direccion, ciudad, provincia, telefono, activo                            | `id_sucursal` único                           | Única copia                  |
| `Producto`  | id_producto, nombre, principio_activo, categoria, presentacion, condicion_venta, precio_unit, activo | `id_producto` único                           | Copia de la colección `productos` |
| `Lote`      | id_lote, nro_lote, unidades, vencimiento (`date`)                                                    | `id_lote` único; índice sobre `unidades` (q08) | Copia de la colección `lotes` |
| `Farmaceutico` | id_farmaceutico, nombre, apellido, matricula, cargo, activo                                       | `id_farmaceutico` único                       | Única copia                  |
| `Cliente`   | id_cliente, nombre, apellido, dni, email, telefono, ciudad, provincia, obra_social, nro_afiliado (ausente si no tiene cobertura), activo | `id_cliente` único | Copia de la colección `clientes` |
| `Receta`    | id_receta, medico, matricula_medico, fecha_emision (`date`), tipo, dispensas_autorizadas, dispensas_realizadas, proxima_dispensa (`date`; ausente si no corresponde), estado | `id_receta` único | Copia de la colección `recetas` |
| `Venta`     | id_venta, fecha (`date`), tipo, medio_pago, total, estado                                            | `id_venta` único; índice sobre `estado` (q02) | Copia de la colección `ventas`: la cabecera en el nodo y cada ítem como relación `INCLUYE` |

Las referencias (`id_proveedor`, `id_producto`, `id_sucursal`, `id_farmaceutico`, `id_cliente` e
`id_receta`) no son propiedades de los nodos: son las relaciones. Los ítems de una venta tampoco son
nodos: cada uno es una relación `INCLUYE` entre la venta y el producto, con `id_detalle`, `cantidad` y
`precio_unit` como propiedades. Cada restricción de unicidad crea además el índice que usan las
búsquedas por id.

### 4.3 Diagramas

**Entidades por motor.** En MongoDB, cada referencia se muestra como `campo ─► colección`: un campo
con el id de la otra entidad. En Neo4j, cada flecha es una relación del grafo, en su dirección.

```text
┌───────────────────────────── MongoDB (base central) ──────────────────────────────┐
│                                                                                   │
│  clientes                recetas                   ventas                         │
│  _id, dni (único)        _id, medico, tipo,        _id, fecha, tipo, total,       │
│  nombre, email, ...      estado, dispensas_*,      medio_pago, estado,            │
│  obra_social, activo,    proxima_dispensa          stock_descontado               │
│  version                 id_cliente ─► clientes    id_cliente ─► clientes         │
│                                                    id_receta ─► recetas           │
│                                                    id_farmaceutico ···► Neo4j     │
│                                                    items[ id_detalle, cantidad,   │
│                                                      precio_unit,                 │
│                                                      id_producto ─► productos ]   │
│                                                                                   │
│  productos                   lotes                                                │
│  _id, nombre, precio_unit,   _id, nro_lote, unidades,                             │
│  condicion_venta, activo     vencimiento                                          │
│  id_proveedor ···► Neo4j     id_producto ─► productos                             │
│                              id_sucursal ···► Neo4j                               │
│                                                                                   │
│  contadores: _id (clientes | ventas | detalle_ventas), ultimo                     │
│                                                                                   │
│  ─►  referencia a otra colección      ···►  referencia a un nodo de Neo4j         │
└───────────────────────────────────────────────────────────────────────────────────┘
        │ copia: productos, lotes, clientes,  ▲ id_proveedor, id_sucursal e
        │ recetas y ventas (con sus ítems)    │ id_farmaceutico apuntan a nodos
        ▼                                     │
┌────────────────────────────────── Neo4j (grafo) ──────────────────────────────────┐
│                                                                                   │
│  (:Proveedor)* ◄─[:PROVISTO_POR]── (:Producto) ◄─[:DE_PRODUCTO]────── (:Lote)     │
│                                         ▲                                │        │
│                                         │                         [:EN_SUCURSAL]  │
│                                     [:INCLUYE]                           ▼        │
│                                         │                          (:Sucursal)*   │
│                                         │                                ▲        │
│                                         │                          [:TRABAJA_EN]  │
│                                         │                                │        │
│  (:Receta) ◄─[:CON_RECETA]────────── (:Venta) ─[:ATENDIDA_POR]─► (:Farmaceutico)* │
│      │                                  │                                         │
│      │ [:EMITIDA_PARA]                  │ [:DE_CLIENTE]                           │
│      │                                  │                                         │
│      └─────────► (:Cliente) ◄───────────┘                                         │
│                                                                                   │
│  * única copia: la escribe solo la carga (npm run seed)                           │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

En el grafo, los ítems de cada venta son relaciones `INCLUYE` entre la venta y cada producto, con la
cantidad y el precio como propiedades. `stock_descontado` y `version` solo están en MongoDB.

**Venta y sus ítems.** Un único documento de la colección `ventas`:

```text
ventas
└── V027
    ├── id_cliente, id_farmaceutico, id_receta (null en ventas libres)
    ├── fecha, tipo, medio_pago, total, estado, stock_descontado
    └── items
        ├── { id_detalle: D035, id_producto: PRD008, cantidad: 1, precio_unit: ... }
        └── { ... }                      (cantidad variable de ítems)
```

---

## 5. Integridad referencial

Ni MongoDB ni Neo4j verifican por sí solos que una referencia apunte a una entidad que existe: en
MongoDB un campo `id_cliente` es un valor cualquiera, y en el grafo una relación une nodos que ya
existen pero no sabe si falta alguno. Por eso la integridad se resuelve en tres niveles.

**1. Modelado embebido.** Los ítems de una venta están dentro de su documento, así que no puede haber
un ítem sin venta ni una venta con ítems de otra. Es la única referencia que se evita por completo en
lugar de validarla.

**2. Validación en la carga (`npm run seed`).** Antes de escribir en cualquier motor, el script
comprueba todo en memoria (§6.1):

- ids únicos en cada entidad, y DNI y matrículas únicos;
- que cada referencia exista: producto → proveedor, lote → producto y sucursal, receta → cliente,
  venta → cliente, farmacéutico y receta, ítem → producto y venta, farmacéutico → sucursal;
- unidades de lote no negativas y que el total de cada venta sea igual a la suma de cantidad por
  precio de sus ítems.

Si una fila no pasa, el script termina con un error que indica fila y regla, y no modifica ningún
dato. Además, cuando escribe en el grafo productos, lotes, farmacéuticos, recetas y ventas, el repositorio
cuenta las relaciones que creó: si alguna no encontró su nodo, aborta la transacción de Neo4j y el
grafo queda como estaba (§3.3, punto 6).

**3. Validación en los servicios de escritura.** Los servicios validan a través de los repositorios
antes de escribir:

- **q13** rechaza un DNI repetido, incluso el de un cliente dado de baja (además del índice único de
  MongoDB sobre `dni`), valida el formato de los datos (DNI, email, teléfono, afiliado según la obra
  social) y en una modificación solo admite cambiar email, teléfono, obra social y número de afiliado:
  el DNI no se modifica. La baja es lógica (`activo: false`): el cliente sigue existiendo para sus
  ventas y recetas.
- **q14** exige que el cliente exista y esté activo (y lo vuelve a confirmar dentro de su transacción,
  §8); que el farmacéutico esté activo y trabaje en una sucursal de tipo 'Farmacia'; que cada producto exista y no esté discontinuado; y que la receta
  pertenezca al cliente y esté vigente. Después, el stock vigente tiene que alcanzar (§8).
- **q15** exige que la venta exista, esté 'Completada', no tenga el stock descontado y que el stock
  vigente de la sucursal alcance para cada ítem.

Las operaciones que escriben varias entidades en MongoDB (q14 y q15) lo hacen dentro de una
transacción, por lo que una validación que falla en medio de la operación descarta todo lo escrito
(§8). El caso que no cubre la transacción es la copia en Neo4j: se escribe después de confirmar, y
si falla se reconstruye con `npm run sync` (§3.3, punto 3).

---

## 6. Estrategia de carga de datos

### 6.1 Cómo funciona `npm run seed`

El script `scripts/seed.ts` hace tres cosas, siempre en este orden:

1. **Lee** cada entidad desde dos carpetas: `data/provistos/` (los CSV de la cátedra) y, si existe un
   archivo con el mismo nombre, `data/adicionales/` (los registros del equipo). Las filas de los dos
   archivos se suman.
2. **Valida todo antes de escribir en cualquier motor**: tipos y formatos de cada campo, valores
   admitidos (tipo de venta, estado, obra social, etc.), ids únicos, DNI y matrículas únicos, que cada
   referencia apunte a una entidad que existe (producto → proveedor, lote → producto y sucursal, receta
   → cliente, venta → cliente, farmacéutico, receta y productos), unidades de lote no negativas, reglas
   de cliente (las mismas que usa q13) y que el total de cada venta sea igual a la suma de sus ítems. Si algo falla, el
   script termina con un error que dice qué fila y qué regla, y no modifica ningún dato.
3. **Escribe** en un orden que respeta las dependencias: proveedores, sucursales, productos, lotes,
   clientes, farmacéuticos, recetas y ventas.

**Es idempotente** porque cada repositorio reemplaza la entidad completa: borra lo que había y vuelve a
cargar todo desde los CSV. Ejecutar `npm run seed` una, dos o diez veces deja los datos en el mismo
estado, y también deja los contadores de ids (§4.1) en el id más alto cargado. El costo es que descarta
lo que hayan escrito los servicios (q13, q14 y q15): para reconstruir solo las copias de Neo4j sin
volver a los CSV existe `npm run sync` (§3.3, punto 3).

### 6.2 Registros adicionales

El enunciado pide al menos 10 registros propios en cada colección. Cada archivo de
`data/adicionales/` tiene el mismo nombre y los mismos encabezados que el provisto, y sus registros
están pensados para ejercitar casos borde de las consultas:

| Archivo | Registros | Caso que ejercita |
| ------- | --------- | ----------------- |
| `proveedores.csv` | PRV006 a PRV015 (10) | Laboratorios y droguerías de varias provincias. PRV012 y PRV015 están inactivos: PRD023 se provee de PRV012, así que q01 muestra un producto activo con un proveedor inactivo |
| `sucursales.csv` | S006 a S015 (10) | Ocho farmacias y dos droguerías. S011 es una farmacia inactiva. Las droguerías (S012, S013) no venden: q05 muestra con 0 ventas a sus farmacéuticos y q10 devuelve una lista vacía para ellas |
| `productos.csv` | PRD014 a PRD023 (10) | Condiciones de venta libre, bajo receta y bajo receta archivada (PRD016). PRD020 está inactivo y PRD023 no tiene principio activo (`No aplica`). q07 cuenta productos vendidos y q14 valida existencia y estado activo |
| `stock_lotes.csv` | L019 a L030 (12) | **Stock bajo** (menos de 50 unidades) en L020, L021, L022, L026 y L030, para q08. **Lotes vencidos** al 15/11/2026: L024 y L030. **Próximos a vencer**: L021 (25/11), L022 (05/12) y L029 (20/12). L030 (vencido) convive con L006 (vigente) del mismo producto y sucursal, para probar que q15 no usa lotes vencidos; L024 no tiene lote vigente que lo reemplace |
| `clientes.csv` | C009 a C018 (10) | **Clientes sin compras**: C009, C011, C012, C015 y C018 (q12). C015 está dado de baja y C012 y C015 no tienen cobertura (sin número de afiliado). C009, C010 y C013 tienen más de una receta (q04) |
| `farmaceuticos.csv` | F008 a F017 (10) | F014 está inactivo. F010, F012, F013, F016 y F017 no tienen ventas: q05 los muestra con 0. F015 trabaja en una droguería |
| `recetas.csv` | RC010 a RC019 (10) | **Recetas vencidas**: RC014 y RC018. Tratamiento prolongado vigente con próxima dispensa atrasada: RC011 y RC013 (q06). RC012 y RC019 todavía no están atrasadas. RC015 es una receta archivada y RC016 está completada, para las validaciones de q14 |
| `ventas.csv` | V017 a V026 (10) | **Fechas recientes** (noviembre de 2026): V017, V018, V019, V021, V022 y V024 cuentan para q11 y q05. **Pendiente**: V023 (q02). **Anuladas**: V020 y V025, que excluyen q05, q07, q09 y q11. V017 suma exactamente $5.000, el borde de q09. V026 es de mayo de 2025: C013 no tiene ventas en el último año (q12) |
| `detalle_ventas.csv` | D023 a D034 (12) | Ítems de esas ventas. El total de cada venta coincide con la suma de sus ítems |

Las fechas de estos registros son fijas, y las consultas calculan "hoy" con la fecha del sistema. Si
se ejecutan en un mes posterior a noviembre de 2026, q11 no encuentra ventas del mes actual, y los
lotes marcados como próximos a vencer ya estarán vencidos.

---

## 7. Consultas y servicios

Para cada consulta y servicio se indica el motor o los motores, cómo se resuelven las relaciones, el
código o la sentencia y un ejemplo de resultado. Los ejemplos son salidas reales de
`npm run query -- <n>` sobre los datos de `npm run seed` (provistos más adicionales, §6), ejecutadas el
15/11/2026. Para q13, q14 y q15 se muestra además el estado de los datos antes y después, y casos de
rechazo por validación.

### Q01: Productos activos con todos los datos de su proveedor

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q01.ts`
- **Motores:** Neo4j (copia de productos y proveedores).
- **Resolución de relaciones:** un único patrón de Cypher,
  `(:Producto {activo: true})-[:PROVISTO_POR]->(:Proveedor)`, resuelto en el servidor en un viaje.
  El repositorio de productos reconstruye `id_proveedor` a partir de la relación.

**Código** (`ProductosRepository.activosConProveedor`, en `src/productos/repository.ts`):

```cypher
MATCH (p:Producto {activo: true})-[:PROVISTO_POR]->(pr:Proveedor)
RETURN p, pr
ORDER BY p.id_producto
```

La función `q01ProductosActivosConProveedor` (`src/queries/q01.ts`) solo llama al repositorio y une cada
producto con su proveedor en un único objeto.

**Ejemplo de resultado** (`npm run query -- 1`). Devuelve los 20 productos activos (quedan afuera
PRD012, PRD013 y PRD020, que no están activos). Extracto con tres de ellos: PRD001 y PRD003, de los
datos provistos, y PRD023, adicional, cuyo proveedor está inactivo (`activo: false`) y que, aun así,
aparece porque la consulta filtra por producto activo y no por proveedor:

```json
[
  {
    "_id": "PRD001",
    "nombre": "Paracetamol 500mg x30",
    "principio_activo": "Paracetamol",
    "categoria": "Analgésico",
    "presentacion": "Comprimidos x30",
    "condicion_venta": "Venta libre",
    "precio_unit": 2800,
    "id_proveedor": "PRV001",
    "activo": true,
    "proveedor": {
      "id_proveedor": "PRV001",
      "razon_social": "Laboratorios Andinos S.A.",
      "cuit": "30-71234567-1",
      "tipo": "Laboratorio",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "telefono": "1143001100",
      "activo": true
    }
  },
  {
    "_id": "PRD003",
    "nombre": "Amoxicilina 500mg x21",
    "principio_activo": "Amoxicilina",
    "categoria": "Antibiótico",
    "presentacion": "Cápsulas x21",
    "condicion_venta": "Bajo receta",
    "precio_unit": 9800,
    "id_proveedor": "PRV003",
    "activo": true,
    "proveedor": {
      "id_proveedor": "PRV003",
      "razon_social": "FarmaLitoral S.A.",
      "cuit": "30-71555222-9",
      "tipo": "Laboratorio",
      "ciudad": "Rosario",
      "provincia": "Santa Fe",
      "telefono": "3414203300",
      "activo": true
    }
  },
  {
    "_id": "PRD023",
    "nombre": "Termómetro digital",
    "principio_activo": "No aplica",
    "categoria": "Dispositivo médico",
    "presentacion": "Unidad",
    "condicion_venta": "Venta libre",
    "precio_unit": 5200,
    "id_proveedor": "PRV012",
    "activo": true,
    "proveedor": {
      "id_proveedor": "PRV012",
      "razon_social": "Sierras Farma S.A.",
      "cuit": "30-71333444-5",
      "tipo": "Laboratorio",
      "ciudad": "Villa Carlos Paz",
      "provincia": "Córdoba",
      "telefono": "3541003030",
      "activo": false
    }
  }
]
```

### Q02: Ventas 'Pendiente' con el farmacéutico asignado (nombre, matrícula y sucursal) y el total

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q02.ts`
- **Motores:** Neo4j (copia de la cabecera de las ventas, farmacéuticos y sucursales).
- **Resolución de relaciones:** un único patrón de Cypher,
  `(:Venta {estado: 'Pendiente'})-[:ATENDIDA_POR]->(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)`, en un
  solo viaje. El plan de ejecución arranca en el índice sobre `Venta.estado` (`NodeIndexSeek`) y desde
  cada venta sigue sus relaciones (`Expand`). El repositorio de ventas reconstruye `id_farmaceutico` a
  partir de la relación.

**Código:**

```cypher
MATCH (v:Venta {estado: $estado})-[:ATENDIDA_POR]->(f:Farmaceutico)-[:TRABAJA_EN]->(s:Sucursal)
RETURN v, f, s
ORDER BY v.id_venta
```

**Ejemplo de resultado** (`npm run query -- 2`). Son las tres ventas pendientes: V011 y V012, de los
datos provistos, y V023, adicional, que atendió F011 en la Farmacia Mendoza Centro (S008):

```json
[
  {
    "_id": "V011",
    "id_farmaceutico": "F006",
    "fecha": "2026-10-12T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Débito",
    "total": 4800,
    "estado": "Pendiente",
    "farmaceutico": {
      "id_farmaceutico": "F006",
      "nombre": "Matías",
      "apellido": "Sandoval",
      "matricula": "MN-18340",
      "cargo": "Director Técnico",
      "id_sucursal": "S004",
      "activo": true
    },
    "sucursal": {
      "id_sucursal": "S004",
      "nombre": "Farmacia Nueva Córdoba",
      "tipo": "Farmacia",
      "direccion": "Bv. Illia 520",
      "ciudad": "Córdoba",
      "provincia": "Córdoba",
      "telefono": "3514004004",
      "activo": true
    }
  },
  {
    "_id": "V012",
    "id_farmaceutico": "F005",
    "fecha": "2026-10-11T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Débito",
    "total": 9200,
    "estado": "Pendiente",
    "farmaceutico": {
      "id_farmaceutico": "F005",
      "nombre": "Natalia",
      "apellido": "Giménez",
      "matricula": "MN-18289",
      "cargo": "Director Técnico",
      "id_sucursal": "S003",
      "activo": true
    },
    "sucursal": {
      "id_sucursal": "S003",
      "nombre": "Farmacia Rosario Centro",
      "tipo": "Farmacia",
      "direccion": "Calle Córdoba 1420",
      "ciudad": "Rosario",
      "provincia": "Santa Fe",
      "telefono": "3414003003",
      "activo": true
    }
  },
  {
    "_id": "V023",
    "id_farmaceutico": "F011",
    "fecha": "2026-11-12T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Obra social",
    "total": 5600,
    "estado": "Pendiente",
    "farmaceutico": {
      "id_farmaceutico": "F011",
      "nombre": "Paula",
      "apellido": "Ibáñez",
      "matricula": "MN-18511",
      "cargo": "Director Técnico",
      "id_sucursal": "S008",
      "activo": true
    },
    "sucursal": {
      "id_sucursal": "S008",
      "nombre": "Farmacia Mendoza Centro",
      "tipo": "Farmacia",
      "direccion": "San Martín 1120",
      "ciudad": "Mendoza",
      "provincia": "Mendoza",
      "telefono": "2614008008",
      "activo": true
    }
  }
]
```

### Q03: Historial completo de un cliente: ventas y recetas ordenadas cronológicamente

- **Tipo:** Lectura · **Parámetros:** `id_cliente` · **Módulo:** `src/queries/q03.ts`
- **Motores:** Neo4j (nodos `Cliente`, `Receta`, `Venta`, `Farmaceutico` y `Producto`).
- **Resolución de relaciones:** recorrido de relaciones en el servidor, en un único patrón. Desde el
  nodo del cliente (búsqueda por la restricción única de `id_cliente`) sigue
  `(:Cliente)<-[:EMITIDA_PARA|DE_CLIENTE]-(h)`, donde `h` es una receta o una venta. Desde cada venta
  sigue `ATENDIDA_POR` (el farmacéutico), `CON_RECETA` (la receta con la que se dispensó) e `INCLUYE`
  (los productos, con la cantidad y el precio de cada ítem). El `ORDER BY` deja el historial ordenado
  en el motor: por fecha (la de la venta o la de emisión de la receta); a igual fecha, la receta antes
  que la venta; y después por id. Es la red cliente–receta–venta–producto que el enunciado describe
  para las consultas de historial (§2.3, punto 2). Si el cliente no existe, la consulta falla con un
  error; un cliente sin ventas ni recetas devuelve una lista vacía.
- **Copia:** el grafo tiene una copia de clientes, recetas y ventas que se escribe después de cada
  servicio (§8). Si esa escritura falló, el historial no muestra el cambio hasta correr `npm run sync`.

**Código:**

```cypher
// ClientesRepository.historial
MATCH (c:Cliente {id_cliente: $idCliente})
OPTIONAL MATCH (c)<-[:EMITIDA_PARA|DE_CLIENTE]-(h)
OPTIONAL MATCH (h)-[:ATENDIDA_POR]->(f:Farmaceutico)
OPTIONAL MATCH (h)-[:CON_RECETA]->(r:Receta)
CALL (h) {
  MATCH (h)-[i:INCLUYE]->(p:Producto)
  WITH i, p
  ORDER BY i.id_detalle
  RETURN collect(i {
    .id_detalle, id_producto: p.id_producto, nombre_producto: p.nombre, .cantidad, .precio_unit
  }) AS items
}
WITH c, h, f, r, items
ORDER BY coalesce(h.fecha, h.fecha_emision), h:Venta, coalesce(h.id_venta, h.id_receta)
RETURN c.id_cliente AS idCliente, collect(CASE WHEN h IS NULL THEN null ELSE {
  nodo: h, esVenta: h:Venta, idFarmaceutico: f.id_farmaceutico, idReceta: r.id_receta,
  items: items
} END) AS historial
```

El repositorio convierte cada nodo a su tipo de dominio (`recetaDesdeNodo` y `ventaDesdeNodo`), que
reconstruye `id_cliente`, `id_farmaceutico` e `id_receta` a partir de las relaciones recorridas.

**Ejemplo de resultado** (`npm run query -- 3 C003`):

```json
[
  {
    "registro": "receta",
    "fecha": "2026-07-15T00:00:00.000Z",
    "_id": "RC002",
    "id_cliente": "C003",
    "medico": "Dra. Silvia Montenegro",
    "matricula_medico": "MP-39877",
    "fecha_emision": "2026-07-15T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 3,
    "dispensas_realizadas": 2,
    "proxima_dispensa": "2026-09-15T00:00:00.000Z",
    "estado": "Vigente"
  },
  {
    "registro": "venta",
    "_id": "V004",
    "id_cliente": "C003",
    "id_farmaceutico": "F006",
    "id_receta": "RC002",
    "fecha": "2026-07-15T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Obra social",
    "total": 5700,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D005",
        "id_producto": "PRD004",
        "nombre_producto": "Losartán 50mg x30",
        "cantidad": 1,
        "precio_unit": 5700
      }
    ]
  },
  {
    "registro": "venta",
    "_id": "V005",
    "id_cliente": "C003",
    "id_farmaceutico": "F006",
    "id_receta": "RC002",
    "fecha": "2026-08-15T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Obra social",
    "total": 12400,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D006",
        "id_producto": "PRD004",
        "nombre_producto": "Losartán 50mg x30",
        "cantidad": 2,
        "precio_unit": 6200
      }
    ]
  }
]
```

### Q04: Clientes con más de una receta registrada, con la cantidad

- **Tipo:** Agregación · **Parámetros:** ninguno · **Módulo:** `src/queries/q04.ts`
- **Motores:** MongoDB (colecciones `recetas` y `clientes`).
- **Resolución de relaciones:** por referencia, resuelta en el servidor. Un único *aggregation
  pipeline* sobre `recetas` agrupa por `id_cliente` (`$group`), se queda con los grupos de más de una
  receta (`$match`) y trae los datos de cada cliente con `$lookup` sobre `clientes`, en un solo viaje.
  Se cuentan las recetas en cualquier estado (vigentes, completadas o vencidas), porque todas quedaron
  registradas. El resultado se ordena por cantidad, de mayor a menor, y a igual cantidad por id de
  cliente.

**Código:**

```ts
// RecetasRepository.clientesConMasRecetasQue(1)
this.coleccion.aggregate([
  { $group: { _id: "$id_cliente", cantidad: { $sum: 1 } } },
  { $match: { cantidad: { $gt: minimo } } },
  { $lookup: { from: "clientes", localField: "_id", foreignField: "_id", as: "cliente" } },
  { $unwind: "$cliente" },
  { $sort: { cantidad: -1, _id: 1 } },
  { $project: { _id: 0, cliente: 1, cantidad: 1 } },
]);
```

**Ejemplo de resultado** (`npm run query -- 4`). Los clientes C001, C002 y C006, de los datos provistos,
tienen dos recetas cada uno. Con las recetas adicionales se suman C009 (RC010 y RC017), C010 (RC011 y
RC012) y C013 (RC013 y RC019):

```json
[
  {
    "_id": "C001",
    "nombre": "Lucía",
    "apellido": "Fernández",
    "dni": "31245678",
    "email": "lucia.f@gmail.com",
    "telefono": "1145112233",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-310045",
    "activo": true,
    "cantidad_recetas": 2
  },
  {
    "_id": "C002",
    "nombre": "Martín",
    "apellido": "Gómez",
    "dni": "28765432",
    "email": "martin.g@gmail.com",
    "telefono": "3415223344",
    "ciudad": "Rosario",
    "provincia": "Santa Fe",
    "obra_social": "Swiss Medical",
    "nro_afiliado": "SM-208811",
    "activo": true,
    "cantidad_recetas": 2
  },
  {
    "_id": "C006",
    "nombre": "Ricardo",
    "apellido": "Paz",
    "dni": "14876543",
    "email": "ricardo.p@gmail.com",
    "telefono": "1167667788",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "PAMI",
    "nro_afiliado": "PA-662871",
    "activo": true,
    "cantidad_recetas": 2
  },
  {
    "_id": "C009",
    "nombre": "Nicolás",
    "apellido": "Aguirre",
    "dni": "42110234",
    "email": "nico.aguirre@gmail.com",
    "telefono": "1161234501",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-420310",
    "activo": true,
    "cantidad_recetas": 2
  },
  {
    "_id": "C010",
    "nombre": "Brenda",
    "apellido": "Castro",
    "dni": "38900123",
    "email": "brenda.c@gmail.com",
    "telefono": "3415120202",
    "ciudad": "Rosario",
    "provincia": "Santa Fe",
    "obra_social": "Swiss Medical",
    "nro_afiliado": "SM-310422",
    "activo": true,
    "cantidad_recetas": 2
  },
  {
    "_id": "C013",
    "nombre": "Raúl",
    "apellido": "Domínguez",
    "dni": "12345678",
    "email": "raul.d@gmail.com",
    "telefono": "1145450505",
    "ciudad": "Quilmes",
    "provincia": "Buenos Aires",
    "obra_social": "PAMI",
    "nro_afiliado": "PA-550211",
    "activo": true,
    "cantidad_recetas": 2
  }
]
```

### Q05: Farmacéuticos activos y cantidad de ventas de los últimos 60 días (sin anuladas, incluye ceros)

- **Tipo:** Agregación · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q05.ts`
- **Motores:** Neo4j (farmacéuticos, sucursales y la copia de la cabecera de las ventas).
- **Resolución de relaciones:** recorrido de relaciones en el servidor, en un viaje. Cada
  `(:Farmaceutico {activo: true})` se une a su sucursal por `TRABAJA_EN` y, con un `OPTIONAL MATCH`,
  a las `(:Venta)` que le llegan por `ATENDIDA_POR`, filtradas por fecha y estado. El patrón opcional
  es el que conserva a los farmacéuticos sin ventas en el período: `count(v)` les da 0. Las fechas
  límite las calcula la aplicación con la fecha del sistema (`src/lib/fechas.ts`): desde hoy menos 60
  días hasta hoy, ambos inclusive. Se envían como `date` de Neo4j, el mismo tipo que `Venta.fecha`.
  Se cuentan las ventas 'Completada' y las 'Pendiente'. El repositorio reconstruye `id_sucursal` a
  partir de la relación `TRABAJA_EN`.

**Código:**

```cypher
MATCH (f:Farmaceutico {activo: true})-[:TRABAJA_EN]->(s:Sucursal)
OPTIONAL MATCH (f)<-[:ATENDIDA_POR]-(v:Venta)
  WHERE v.fecha >= $desde AND v.fecha <= $hasta AND v.estado <> 'Anulada'
RETURN f, s.id_sucursal AS idSucursal, count(v) AS cantidad
ORDER BY cantidad DESC, f.id_farmaceutico
```

**Ejemplo de resultado** (`npm run query -- 5`, ejecutado el 15/11/2026, así que cuenta desde el
16/09/2026). Hay siete farmacéuticos con 0 ventas en el período: F007 y F015 trabajan en droguerías, que
no registran ventas, y F010, F012, F013, F016 y F017 son farmacéuticos adicionales sin ventas. F004 y F014
no aparecen porque están inactivos. Las ventas anuladas V015, V020 y V025 no se cuentan, y V011 y V012, que
están pendientes, sí:

```json
[
  {
    "id_farmaceutico": "F005",
    "nombre": "Natalia",
    "apellido": "Giménez",
    "matricula": "MN-18289",
    "cargo": "Director Técnico",
    "id_sucursal": "S003",
    "activo": true,
    "cantidad_ventas": 4
  },
  {
    "id_farmaceutico": "F001",
    "nombre": "Mariana",
    "apellido": "Quiroga",
    "matricula": "MN-18041",
    "cargo": "Director Técnico",
    "id_sucursal": "S001",
    "activo": true,
    "cantidad_ventas": 2
  },
  {
    "id_farmaceutico": "F002",
    "nombre": "Sebastián",
    "apellido": "Ledesma",
    "matricula": "MN-18078",
    "cargo": "Farmacéutico",
    "id_sucursal": "S001",
    "activo": true,
    "cantidad_ventas": 2
  },
  {
    "id_farmaceutico": "F006",
    "nombre": "Matías",
    "apellido": "Sandoval",
    "matricula": "MN-18340",
    "cargo": "Director Técnico",
    "id_sucursal": "S004",
    "activo": true,
    "cantidad_ventas": 2
  },
  {
    "id_farmaceutico": "F011",
    "nombre": "Paula",
    "apellido": "Ibáñez",
    "matricula": "MN-18511",
    "cargo": "Director Técnico",
    "id_sucursal": "S008",
    "activo": true,
    "cantidad_ventas": 2
  },
  {
    "id_farmaceutico": "F003",
    "nombre": "Carolina",
    "apellido": "Benítez",
    "matricula": "MN-18112",
    "cargo": "Director Técnico",
    "id_sucursal": "S002",
    "activo": true,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F008",
    "nombre": "Lucas",
    "apellido": "Medina",
    "matricula": "MN-18455",
    "cargo": "Director Técnico",
    "id_sucursal": "S006",
    "activo": true,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F009",
    "nombre": "Valeria",
    "apellido": "Domínguez",
    "matricula": "MN-18462",
    "cargo": "Farmacéutico",
    "id_sucursal": "S006",
    "activo": true,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F007",
    "nombre": "Romina",
    "apellido": "Acuña",
    "matricula": "MN-18401",
    "cargo": "Director Técnico",
    "id_sucursal": "S005",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F010",
    "nombre": "Gonzalo",
    "apellido": "Herrera",
    "matricula": "MN-18490",
    "cargo": "Director Técnico",
    "id_sucursal": "S007",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F012",
    "nombre": "Diego",
    "apellido": "Sosa",
    "matricula": "MN-18530",
    "cargo": "Director Técnico",
    "id_sucursal": "S009",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F013",
    "nombre": "Florencia",
    "apellido": "Rojas",
    "matricula": "MN-18544",
    "cargo": "Director Técnico",
    "id_sucursal": "S010",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F015",
    "nombre": "Camila",
    "apellido": "Peralta",
    "matricula": "MN-18577",
    "cargo": "Director Técnico",
    "id_sucursal": "S012",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F016",
    "nombre": "Tomás",
    "apellido": "Villalba",
    "matricula": "MN-18593",
    "cargo": "Director Técnico",
    "id_sucursal": "S014",
    "activo": true,
    "cantidad_ventas": 0
  },
  {
    "id_farmaceutico": "F017",
    "nombre": "Agustina",
    "apellido": "Luna",
    "matricula": "MN-18610",
    "cargo": "Director Técnico",
    "id_sucursal": "S015",
    "activo": true,
    "cantidad_ventas": 0
  }
]
```

### Q06: Recetas de tratamiento prolongado 'Vigente' con próxima dispensa anterior a hoy, con datos del cliente

- **Tipo:** Lectura · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q06.ts`
- **Motores:** MongoDB (colecciones `recetas` y `clientes`).
- **Resolución de relaciones:** por referencia, resuelta en el servidor. Un único *aggregation
  pipeline* sobre `recetas` filtra por tipo, estado y próxima dispensa (`$match`) y trae el cliente de
  cada receta con `$lookup` sobre `clientes`, en un solo viaje. El filtro usa el índice compuesto
  `{tipo: 1, estado: 1, proxima_dispensa: 1}` (`IXSCAN`). "Hoy" lo calcula la aplicación con la
  fecha del sistema (`src/lib/fechas.ts`): una receta cuya próxima dispensa es hoy todavía no está
  atrasada. El resultado va de la próxima dispensa más atrasada a la más reciente.

**Código:**

```ts
// RecetasRepository.vigentesConDispensaAntesDe("Tratamiento prolongado", hoy())
this.coleccion.aggregate([
  { $match: { tipo, estado: "Vigente", proxima_dispensa: { $lt: fecha } } },
  { $sort: { proxima_dispensa: 1, _id: 1 } },
  { $lookup: { from: "clientes", localField: "id_cliente", foreignField: "_id", as: "cliente" } },
  { $unwind: "$cliente" },
]);
```

**Ejemplo de resultado** (`npm run query -- 6`, ejecutado el 15/11/2026). Además de las tres recetas de los
datos provistos, aparecen RC013 (C013, próxima dispensa el 10/10/2026) y RC011 (C010, el 01/11/2026), que
son adicionales. RC012 (próxima dispensa el 20/11/2026) y RC019 (el 10/12/2026) todavía no están atrasadas,
y RC016 está completada, así que no entran:

```json
[
  {
    "_id": "RC002",
    "id_cliente": "C003",
    "medico": "Dra. Silvia Montenegro",
    "matricula_medico": "MP-39877",
    "fecha_emision": "2026-07-15T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 3,
    "dispensas_realizadas": 2,
    "proxima_dispensa": "2026-09-15T00:00:00.000Z",
    "estado": "Vigente",
    "cliente": {
      "_id": "C003",
      "nombre": "Carla",
      "apellido": "Ruiz",
      "dni": "40123456",
      "email": "carla.r@gmail.com",
      "telefono": "3515334455",
      "ciudad": "Córdoba",
      "provincia": "Córdoba",
      "obra_social": "PAMI",
      "nro_afiliado": "PA-771203",
      "activo": true
    }
  },
  {
    "_id": "RC003",
    "id_cliente": "C006",
    "medico": "Dr. Pablo Echeverría",
    "matricula_medico": "MP-41203",
    "fecha_emision": "2026-08-01T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 3,
    "dispensas_realizadas": 2,
    "proxima_dispensa": "2026-10-01T00:00:00.000Z",
    "estado": "Vigente",
    "cliente": {
      "_id": "C006",
      "nombre": "Ricardo",
      "apellido": "Paz",
      "dni": "14876543",
      "email": "ricardo.p@gmail.com",
      "telefono": "1167667788",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "obra_social": "PAMI",
      "nro_afiliado": "PA-662871",
      "activo": true
    }
  },
  {
    "_id": "RC013",
    "id_cliente": "C013",
    "medico": "Dr. Ernesto Villar",
    "matricula_medico": "MP-39001",
    "fecha_emision": "2026-08-10T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 3,
    "dispensas_realizadas": 1,
    "proxima_dispensa": "2026-10-10T00:00:00.000Z",
    "estado": "Vigente",
    "cliente": {
      "_id": "C013",
      "nombre": "Raúl",
      "apellido": "Domínguez",
      "dni": "12345678",
      "email": "raul.d@gmail.com",
      "telefono": "1145450505",
      "ciudad": "Quilmes",
      "provincia": "Buenos Aires",
      "obra_social": "PAMI",
      "nro_afiliado": "PA-550211",
      "activo": true
    }
  },
  {
    "_id": "RC004",
    "id_cliente": "C006",
    "medico": "Dr. Pablo Echeverría",
    "matricula_medico": "MP-41203",
    "fecha_emision": "2026-09-20T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 3,
    "dispensas_realizadas": 1,
    "proxima_dispensa": "2026-10-20T00:00:00.000Z",
    "estado": "Vigente",
    "cliente": {
      "_id": "C006",
      "nombre": "Ricardo",
      "apellido": "Paz",
      "dni": "14876543",
      "email": "ricardo.p@gmail.com",
      "telefono": "1167667788",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "obra_social": "PAMI",
      "nro_afiliado": "PA-662871",
      "activo": true
    }
  },
  {
    "_id": "RC011",
    "id_cliente": "C010",
    "medico": "Dra. Lucrecia Páez",
    "matricula_medico": "MP-51230",
    "fecha_emision": "2026-09-01T00:00:00.000Z",
    "tipo": "Tratamiento prolongado",
    "dispensas_autorizadas": 4,
    "dispensas_realizadas": 2,
    "proxima_dispensa": "2026-11-01T00:00:00.000Z",
    "estado": "Vigente",
    "cliente": {
      "_id": "C010",
      "nombre": "Brenda",
      "apellido": "Castro",
      "dni": "38900123",
      "email": "brenda.c@gmail.com",
      "telefono": "3415120202",
      "ciudad": "Rosario",
      "provincia": "Santa Fe",
      "obra_social": "Swiss Medical",
      "nro_afiliado": "SM-310422",
      "activo": true
    }
  }
]
```

### Q07: Top 5 productos más vendidos en unidades (solo ventas 'Completada')

- **Tipo:** Agregación · **Parámetros:** ninguno · **Módulo:** `src/queries/q07.ts`
- **Motores:** MongoDB (colecciones `ventas` y `productos`).
- **Resolución de relaciones:** los ítems están embebidos en cada venta y el producto se trae por
  referencia, todo en el servidor. Un único *aggregation pipeline* sobre `ventas` filtra las
  'Completada' (`$match`, con el prefijo `estado` del índice `{estado: 1, fecha: 1}`), desarma los
  ítems (`$unwind`), suma `cantidad` por producto (`$group`), ordena y se queda con cinco
  (`$sort` + `$limit`). Recién después trae los datos de esos cinco productos con `$lookup` sobre
  `productos`. A igual cantidad de unidades se ordena por id de producto, así que un empate en el
  quinto puesto se resuelve por id. Los productos discontinuados también cuentan, porque se vendieron.

**Código:**

```ts
// VentasRepository.productosMasVendidos(5)
this.coleccion.aggregate([
  { $match: { estado: "Completada" } },
  { $unwind: "$items" },
  { $group: { _id: "$items.id_producto", unidades: { $sum: "$items.cantidad" } } },
  { $sort: { unidades: -1, _id: 1 } },
  { $limit: limite },
  { $lookup: { from: "productos", localField: "_id", foreignField: "_id", as: "producto" } },
  { $unwind: "$producto" },
  { $project: { _id: 0, producto: 1, unidades: 1 } },
]);
```

**Ejemplo de resultado** (`npm run query -- 7`). Con las ventas adicionales, PRD001 suma 9 unidades y
PRD011 pasa a 7. A PRD011 no le suman la venta pendiente V012 ni la anulada V020, y a PRD001 no le suma
la anulada V025. PRD002 y PRD009 empatan con 2 unidades y el desempate por id deja a PRD002 en el quinto
puesto:

```json
[
  {
    "_id": "PRD001",
    "nombre": "Paracetamol 500mg x30",
    "principio_activo": "Paracetamol",
    "categoria": "Analgésico",
    "presentacion": "Comprimidos x30",
    "condicion_venta": "Venta libre",
    "precio_unit": 2800,
    "id_proveedor": "PRV001",
    "activo": true,
    "unidades_vendidas": 9
  },
  {
    "_id": "PRD011",
    "nombre": "Loratadina 10mg x10",
    "principio_activo": "Loratadina",
    "categoria": "Antihistamínico",
    "presentacion": "Comprimidos x10",
    "condicion_venta": "Venta libre",
    "precio_unit": 2200,
    "id_proveedor": "PRV001",
    "activo": true,
    "unidades_vendidas": 7
  },
  {
    "_id": "PRD005",
    "nombre": "Metformina 850mg x60",
    "principio_activo": "Metformina",
    "categoria": "Antidiabético",
    "presentacion": "Comprimidos x60",
    "condicion_venta": "Bajo receta",
    "precio_unit": 5400,
    "id_proveedor": "PRV003",
    "activo": true,
    "unidades_vendidas": 6
  },
  {
    "_id": "PRD004",
    "nombre": "Losartán 50mg x30",
    "principio_activo": "Losartán",
    "categoria": "Antihipertensivo",
    "presentacion": "Comprimidos x30",
    "condicion_venta": "Bajo receta",
    "precio_unit": 6200,
    "id_proveedor": "PRV002",
    "activo": true,
    "unidades_vendidas": 3
  },
  {
    "_id": "PRD002",
    "nombre": "Ibuprofeno 400mg x20",
    "principio_activo": "Ibuprofeno",
    "categoria": "Antiinflamatorio",
    "presentacion": "Comprimidos x20",
    "condicion_venta": "Venta libre",
    "precio_unit": 3500,
    "id_proveedor": "PRV001",
    "activo": true,
    "unidades_vendidas": 2
  }
]
```

### Q08: Lotes con menos de 50 unidades, con producto, sucursal y proveedor

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q08.ts`
- **Motores:** Neo4j (copias de lotes y productos, sucursales y proveedores).
- **Resolución de relaciones:** un único patrón de Cypher que recorre las tres relaciones del lote,
  `(:Lote)-[:DE_PRODUCTO]->(:Producto)-[:PROVISTO_POR]->(:Proveedor)` y
  `(:Lote)-[:EN_SUCURSAL]->(:Sucursal)`, en un solo viaje. El plan de ejecución arranca en el índice
  sobre `Lote.unidades` (`NodeIndexSeekByRange`) y desde cada lote sigue sus relaciones
  (`Expand`). Las unidades se leen de la copia del grafo: q15 la actualiza después de confirmar cada
  descuento de stock en MongoDB (§8).

**Código** (`LotesRepository.conMenosUnidadesQue`, en `src/lotes/repository.ts`, con `$limite` = 50):

```cypher
MATCH (l:Lote)-[:DE_PRODUCTO]->(p:Producto)-[:PROVISTO_POR]->(pr:Proveedor),
      (l)-[:EN_SUCURSAL]->(s:Sucursal)
WHERE l.unidades < $limite
RETURN l, p, s, pr
ORDER BY l.id_lote
```

La función `q08LotesConStockBajo` (`src/queries/q08.ts`) fija el umbral en 50 unidades y combina cada
lote con su producto, su sucursal y su proveedor en un único objeto.

**Ejemplo de resultado** (`npm run query -- 8`). Devuelve 14 lotes. La consulta filtra solo por
unidades, así que incluye también lotes que ya vencieron. Extracto con tres: L003 (18 unidades, vence
el 15/12/2026), L012 (30 unidades, vencido el 31/10/2026) y L018 (15 unidades, de un producto inactivo,
vencido el 30/09/2026):

```json
[
  {
    "_id": "L003",
    "id_producto": "PRD001",
    "id_sucursal": "S003",
    "nro_lote": "L-2412B",
    "unidades": 18,
    "vencimiento": "2026-12-15T00:00:00.000Z",
    "producto": {
      "_id": "PRD001",
      "nombre": "Paracetamol 500mg x30",
      "principio_activo": "Paracetamol",
      "categoria": "Analgésico",
      "presentacion": "Comprimidos x30",
      "condicion_venta": "Venta libre",
      "precio_unit": 2800,
      "id_proveedor": "PRV001",
      "activo": true
    },
    "sucursal": {
      "id_sucursal": "S003",
      "nombre": "Farmacia Rosario Centro",
      "tipo": "Farmacia",
      "direccion": "Calle Córdoba 1420",
      "ciudad": "Rosario",
      "provincia": "Santa Fe",
      "telefono": "3414003003",
      "activo": true
    },
    "proveedor": {
      "id_proveedor": "PRV001",
      "razon_social": "Laboratorios Andinos S.A.",
      "cuit": "30-71234567-1",
      "tipo": "Laboratorio",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "telefono": "1143001100",
      "activo": true
    }
  },
  {
    "_id": "L012",
    "id_producto": "PRD010",
    "id_sucursal": "S002",
    "nro_lote": "L-2505F",
    "unidades": 30,
    "vencimiento": "2026-10-31T00:00:00.000Z",
    "producto": {
      "_id": "PRD010",
      "nombre": "Salbutamol aerosol 100mcg",
      "principio_activo": "Salbutamol",
      "categoria": "Broncodilatador",
      "presentacion": "Aerosol 200 dosis",
      "condicion_venta": "Bajo receta",
      "precio_unit": 7100,
      "id_proveedor": "PRV001",
      "activo": true
    },
    "sucursal": {
      "id_sucursal": "S002",
      "nombre": "Farmacia Belgrano",
      "tipo": "Farmacia",
      "direccion": "Av. Cabildo 2150",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "telefono": "1148002002",
      "activo": true
    },
    "proveedor": {
      "id_proveedor": "PRV001",
      "razon_social": "Laboratorios Andinos S.A.",
      "cuit": "30-71234567-1",
      "tipo": "Laboratorio",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "telefono": "1143001100",
      "activo": true
    }
  },
  {
    "_id": "L018",
    "id_producto": "PRD012",
    "id_sucursal": "S002",
    "nro_lote": "L-2301Z",
    "unidades": 15,
    "vencimiento": "2026-09-30T00:00:00.000Z",
    "producto": {
      "_id": "PRD012",
      "nombre": "Alcohol en gel 250ml",
      "principio_activo": "Alcohol etílico 70%",
      "categoria": "Antiséptico",
      "presentacion": "Solución 250 ml",
      "condicion_venta": "Venta libre",
      "precio_unit": 1800,
      "id_proveedor": "PRV002",
      "activo": false
    },
    "sucursal": {
      "id_sucursal": "S002",
      "nombre": "Farmacia Belgrano",
      "tipo": "Farmacia",
      "direccion": "Av. Cabildo 2150",
      "ciudad": "Buenos Aires",
      "provincia": "Buenos Aires",
      "telefono": "1148002002",
      "activo": true
    },
    "proveedor": {
      "id_proveedor": "PRV002",
      "razon_social": "DroguMed S.R.L.",
      "cuit": "30-70987654-3",
      "tipo": "Droguería",
      "ciudad": "Córdoba",
      "provincia": "Córdoba",
      "telefono": "3514102200",
      "activo": true
    }
  }
]
```

### Q09: Ventas 'Venta libre' con total menor a $5.000 (sin anuladas)

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q09.ts`
- **Motores:** MongoDB (colección `ventas`).
- **Resolución de relaciones:** no cruza otras entidades. Los ítems de cada venta están embebidos,
  así que llegan en el mismo documento. Es un `find` que filtra con el índice `{tipo: 1, total: 1}`
  (`IXSCAN`) y descarta las anuladas. Una venta de exactamente $5.000 no entra, porque el total tiene
  que ser menor.

**Código:**

```ts
// VentasRepository.noAnuladasDeTipoConTotalMenorA("Venta libre", 5000)
this.coleccion
  .find({ tipo, total: { $lt: maximo }, estado: { $ne: "Anulada" } })
  .sort({ fecha: 1, _id: 1 });
```

**Ejemplo de resultado** (`npm run query -- 9`). Hay cinco ventas libres de menos de $5.000: V026 (de mayo
de 2025), V013, V014, V018 y V022. Quedan afuera V015 y V020, que son ventas libres de menos de $5.000 pero
están anuladas, y V017, que suma exactamente $5.000:

```json
[
  {
    "_id": "V026",
    "id_cliente": "C013",
    "id_farmaceutico": "F001",
    "id_receta": null,
    "fecha": "2025-05-10T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Efectivo",
    "total": 3500,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D034",
        "id_producto": "PRD002",
        "cantidad": 1,
        "precio_unit": 3500
      }
    ],
    "stock_descontado": false
  },
  {
    "_id": "V013",
    "id_cliente": "C001",
    "id_farmaceutico": "F001",
    "id_receta": null,
    "fecha": "2026-10-02T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Efectivo",
    "total": 4400,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D017",
        "id_producto": "PRD011",
        "cantidad": 2,
        "precio_unit": 2200
      }
    ],
    "stock_descontado": false
  },
  {
    "_id": "V014",
    "id_cliente": "C005",
    "id_farmaceutico": "F005",
    "id_receta": null,
    "fecha": "2026-10-05T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Efectivo",
    "total": 4600,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D018",
        "id_producto": "PRD001",
        "cantidad": 1,
        "precio_unit": 2800
      },
      {
        "id_detalle": "D019",
        "id_producto": "PRD012",
        "cantidad": 1,
        "precio_unit": 1800
      }
    ],
    "stock_descontado": false
  },
  {
    "_id": "V018",
    "id_cliente": "C002",
    "id_farmaceutico": "F005",
    "id_receta": null,
    "fecha": "2026-11-04T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Débito",
    "total": 3500,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D025",
        "id_producto": "PRD002",
        "cantidad": 1,
        "precio_unit": 3500
      }
    ],
    "stock_descontado": false
  },
  {
    "_id": "V022",
    "id_cliente": "C016",
    "id_farmaceutico": "F009",
    "id_receta": null,
    "fecha": "2026-11-09T00:00:00.000Z",
    "tipo": "Venta libre",
    "medio_pago": "Efectivo",
    "total": 2200,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D030",
        "id_producto": "PRD011",
        "cantidad": 1,
        "precio_unit": 2200
      }
    ],
    "stock_descontado": false
  }
]
```

### Q10: Clientes atendidos en una sucursal (a través del farmacéutico de la venta, activo o no)

- **Tipo:** Lectura · **Parámetros:** `id_sucursal` · **Módulo:** `src/queries/q10.ts`
- **Motores:** Neo4j (sucursales, farmacéuticos y las copias de ventas y clientes).
- **Resolución de relaciones:** recorrido de relaciones en el servidor, en un viaje. Desde la
  sucursal, el patrón sigue tres relaciones:
  `(:Sucursal)<-[:TRABAJA_EN]-(:Farmaceutico)<-[:ATENDIDA_POR]-(:Venta)-[:DE_CLIENTE]->(:Cliente)`.
  La sucursal se llega a través del farmacéutico que registró la venta, como pide el enunciado. No se
  filtra por `Farmaceutico.activo`, así que cuentan las ventas de farmacéuticos que ya no trabajan en
  la red. Se cuentan las ventas en cualquier estado, porque una venta pendiente o anulada también es
  una atención, y se incluyen los clientes dados de baja. `collect(DISTINCT c)` devuelve cada
  cliente una sola vez. Con el `OPTIONAL MATCH`, una sucursal sin ventas (la droguería) devuelve una
  lista vacía. Si la sucursal no existe, no hay fila y la consulta falla con un error.

**Código:**

```cypher
MATCH (s:Sucursal {id_sucursal: $idSucursal})
OPTIONAL MATCH (s)<-[:TRABAJA_EN]-(:Farmaceutico)<-[:ATENDIDA_POR]-(:Venta)-[:DE_CLIENTE]->(c:Cliente)
WITH s, c
ORDER BY c.id_cliente
RETURN s.id_sucursal AS idSucursal, collect(DISTINCT c) AS clientes
```

**Ejemplo de resultado** (`npm run query -- 10 S002`). C004 aparece por la venta V001, que atendió
F004, un farmacéutico que hoy está inactivo. C001 aparece por V010 (y por V020, anulada):

```json
[
  {
    "_id": "C001",
    "nombre": "Lucía",
    "apellido": "Fernández",
    "dni": "31245678",
    "email": "lucia.f@gmail.com",
    "telefono": "1145112233",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-310045",
    "activo": true
  },
  {
    "_id": "C004",
    "nombre": "Federico",
    "apellido": "Navarro",
    "dni": "33987654",
    "email": "fede.n@gmail.com",
    "telefono": "1156445566",
    "ciudad": "Vicente López",
    "provincia": "Buenos Aires",
    "obra_social": "IOMA",
    "nro_afiliado": "IO-450912",
    "activo": true
  }
]
```

### Q11: Ingresos totales por farmacéutico en el mes actual (solo 'Completada')

- **Tipo:** Agregación · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q11.ts`
- **Motores:** MongoDB (colección `ventas`) y Neo4j (farmacéuticos).
- **Resolución de relaciones:** combinación en la aplicación. La agregación es un filtro por estado y
  período más un `$group`, que no recorre relaciones, así que va a MongoDB (§2.3). Un *aggregation
  pipeline* sobre `ventas` filtra las 'Completada' del mes con el índice `{estado: 1, fecha: 1}`
  (`IXSCAN`) y agrupa por `id_farmaceutico`, sumando `total` y contando ventas. Los farmacéuticos
  viven solo en Neo4j: con los ids que devolvió la agregación, la aplicación los lee en una única
  consulta (`WHERE f.id_farmaceutico IN $ids`) y combina los dos resultados. Si una venta
  referenciara un farmacéutico que no está en el grafo, la consulta falla en lugar de omitirlo. "Mes
  actual" va del primer día del mes de hoy (inclusive) al primer día del mes siguiente (exclusive),
  calculados con la fecha del sistema (`src/lib/fechas.ts`). Solo aparecen los farmacéuticos con
  ventas completadas en el mes, estén activos o no.

**Código:**

```ts
// VentasRepository.ingresosPorFarmaceutico(inicioDeMes(hoy()), inicioDelMesSiguiente(hoy()))
this.coleccion.aggregate([
  { $match: { estado: "Completada", fecha: { $gte: desde, $lt: hasta } } },
  { $group: { _id: "$id_farmaceutico", ingresos: { $sum: "$total" }, cantidad_ventas: { $sum: 1 } } },
  { $sort: { ingresos: -1, _id: 1 } },
  { $project: { _id: 0, id_farmaceutico: "$_id", ingresos: 1, cantidad_ventas: 1 } },
]);
```

```cypher
// FarmaceuticosRepository.buscarPorIds(ids)
MATCH (f:Farmaceutico)-[:TRABAJA_EN]->(s:Sucursal)
WHERE f.id_farmaceutico IN $ids
RETURN f, s.id_sucursal AS idSucursal
```

**Ejemplo de resultado** (`npm run query -- 11`, ejecutado el 15/11/2026, así que el mes actual es
noviembre de 2026). Salen de las ventas completadas de noviembre: V017, V018, V019, V021, V022 y V024 (§6).
V020 y V025 están anuladas, V023 está pendiente y las ventas de octubre quedan fuera del período:

```json
[
  {
    "id_farmaceutico": "F008",
    "nombre": "Lucas",
    "apellido": "Medina",
    "matricula": "MN-18455",
    "cargo": "Director Técnico",
    "id_sucursal": "S006",
    "activo": true,
    "ingresos_totales": 9000,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F006",
    "nombre": "Matías",
    "apellido": "Sandoval",
    "matricula": "MN-18340",
    "cargo": "Director Técnico",
    "id_sucursal": "S004",
    "activo": true,
    "ingresos_totales": 8400,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F011",
    "nombre": "Paula",
    "apellido": "Ibáñez",
    "matricula": "MN-18511",
    "cargo": "Director Técnico",
    "id_sucursal": "S008",
    "activo": true,
    "ingresos_totales": 6800,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F001",
    "nombre": "Mariana",
    "apellido": "Quiroga",
    "matricula": "MN-18041",
    "cargo": "Director Técnico",
    "id_sucursal": "S001",
    "activo": true,
    "ingresos_totales": 5000,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F005",
    "nombre": "Natalia",
    "apellido": "Giménez",
    "matricula": "MN-18289",
    "cargo": "Director Técnico",
    "id_sucursal": "S003",
    "activo": true,
    "ingresos_totales": 3500,
    "cantidad_ventas": 1
  },
  {
    "id_farmaceutico": "F009",
    "nombre": "Valeria",
    "apellido": "Domínguez",
    "matricula": "MN-18462",
    "cargo": "Farmacéutico",
    "id_sucursal": "S006",
    "activo": true,
    "ingresos_totales": 2200,
    "cantidad_ventas": 1
  }
]
```

### Q12: Clientes sin ventas en el último año

- **Tipo:** Lectura · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q12.ts`
- **Motores:** Neo4j (copias de clientes y ventas).
- **Resolución de relaciones:** patrón negado sobre la relación `(:Venta)-[:DE_CLIENTE]->(:Cliente)`,
  resuelto en el servidor en un viaje. `NOT EXISTS { ... }` se queda con los clientes para los que no
  existe ninguna venta con fecha dentro del último año. Un `OPTIONAL MATCH` agrega la fecha de su
  última venta (`max`), que distingue a quien dejó de comprar de quien nunca compró (`null`). "Último
  año" va desde la misma fecha de hace un año hasta hoy, calculado con la fecha del sistema
  (`src/lib/fechas.ts`). Se cuentan las ventas en cualquier estado, porque las pendientes y las
  anuladas también quedaron registradas, y se incluyen los clientes dados de baja. Como Neo4j no guarda
  propiedades nulas, el repositorio devuelve `nro_afiliado: null` cuando el nodo no la tiene.

**Código:**

```cypher
MATCH (c:Cliente)
WHERE NOT EXISTS { (c)<-[:DE_CLIENTE]-(v:Venta) WHERE v.fecha >= $desde }
OPTIONAL MATCH (c)<-[:DE_CLIENTE]-(anterior:Venta)
RETURN c, max(anterior.fecha) AS ultimaVenta
ORDER BY c.id_cliente
```

**Ejemplo de resultado** (`npm run query -- 12`, ejecutado el 15/11/2026, así que cuenta desde el
15/11/2025). C004 compró por última vez el 18/09/2025 y C013, el 10/05/2025 (V026, adicional). C008 y
C015, dados de baja, y C009, C011, C012 y C018 nunca compraron. C005 tiene una venta de junio de 2025,
pero no aparece porque también compró en el último año:

```json
[
  {
    "_id": "C004",
    "nombre": "Federico",
    "apellido": "Navarro",
    "dni": "33987654",
    "email": "fede.n@gmail.com",
    "telefono": "1156445566",
    "ciudad": "Vicente López",
    "provincia": "Buenos Aires",
    "obra_social": "IOMA",
    "nro_afiliado": "IO-450912",
    "activo": true,
    "ultima_venta": "2025-09-18T00:00:00.000Z"
  },
  {
    "_id": "C008",
    "nombre": "Hugo",
    "apellido": "Mansilla",
    "dni": "25678901",
    "email": "hugo.m@gmail.com",
    "telefono": "1178889900",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": false,
    "ultima_venta": null
  },
  {
    "_id": "C009",
    "nombre": "Nicolás",
    "apellido": "Aguirre",
    "dni": "42110234",
    "email": "nico.aguirre@gmail.com",
    "telefono": "1161234501",
    "ciudad": "Buenos Aires",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-420310",
    "activo": true,
    "ultima_venta": null
  },
  {
    "_id": "C011",
    "nombre": "Esteban",
    "apellido": "Molina",
    "dni": "29876543",
    "email": "esteban.m@gmail.com",
    "telefono": "2614230303",
    "ciudad": "Mendoza",
    "provincia": "Mendoza",
    "obra_social": "Galeno",
    "nro_afiliado": "GA-118833",
    "activo": true,
    "ultima_venta": null
  },
  {
    "_id": "C012",
    "nombre": "Marina",
    "apellido": "Ortiz",
    "dni": "35123987",
    "email": "marina.o@gmail.com",
    "telefono": "3814340404",
    "ciudad": "San Miguel de Tucumán",
    "provincia": "Tucumán",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": true,
    "ultima_venta": null
  },
  {
    "_id": "C013",
    "nombre": "Raúl",
    "apellido": "Domínguez",
    "dni": "12345678",
    "email": "raul.d@gmail.com",
    "telefono": "1145450505",
    "ciudad": "Quilmes",
    "provincia": "Buenos Aires",
    "obra_social": "PAMI",
    "nro_afiliado": "PA-550211",
    "activo": true,
    "ultima_venta": "2025-05-10T00:00:00.000Z"
  },
  {
    "_id": "C015",
    "nombre": "Joaquín",
    "apellido": "Funes",
    "dni": "36456789",
    "email": "joaquin.f@gmail.com",
    "telefono": "2994670707",
    "ciudad": "Neuquén",
    "provincia": "Neuquén",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": false,
    "ultima_venta": null
  },
  {
    "_id": "C018",
    "nombre": "Daniela",
    "apellido": "Ferreyra",
    "dni": "40234567",
    "email": "dani.f@gmail.com",
    "telefono": "3515901010",
    "ciudad": "Córdoba",
    "provincia": "Córdoba",
    "obra_social": "Galeno",
    "nro_afiliado": "GA-771920",
    "activo": true,
    "ultima_venta": null
  }
]
```

### Q13: ABM de clientes: alta (DNI único), modificación de contacto y cobertura, baja lógica

- **Tipo:** Servicio · **Parámetros:** la operación (`alta`, `modificar` o `baja`); para el alta,
  los datos del cliente; para la modificación, `id_cliente` y los campos a cambiar; para la baja,
  `id_cliente` · **Módulo:** `src/queries/q13.ts`
- **Motores:** MongoDB (colección `clientes`, fuente de verdad, y colección `contadores`) y Neo4j
  (copia en el nodo `(:Cliente)`). Cada operación escribe primero en MongoDB y después actualiza el
  nodo. Si esa segunda escritura falla, el cliente queda guardado en MongoDB, el servicio lo informa
  y `npm run sync` reconstruye la copia desde MongoDB (§3.3, punto 3).
- **Validaciones:**
  - **Alta:** campos obligatorios; DNI de 7 u 8 dígitos; email con formato válido; teléfono solo
    con dígitos; obra social entre las admitidas por el enunciado; número de afiliado vacío si y
    solo si la obra social es 'Sin cobertura'; **DNI único** entre todos los clientes, activos o
    dados de baja.
  - **Modificación:** solo email, teléfono, obra social y número de afiliado (nombre, apellido, DNI
    y domicilio no se modifican). El cliente tiene que existir y estar activo, y se valida como queda
    después del cambio: pasar a 'Sin cobertura' exige vaciar también el número de afiliado.
  - **Baja:** el cliente tiene que existir y estar activo. La baja es lógica: `activo` pasa a
    `false`, y el cliente y su DNI siguen registrados.
- **Escrituras simultáneas:**
  - **DNI único:** lo garantiza el índice único sobre `dni`. El servicio consulta antes para dar un
    mensaje claro, pero si dos altas con el mismo DNI pasan esa consulta a la vez, el índice rechaza
    la segunda. Con cinco altas simultáneas con el mismo DNI se registró una y se rechazaron cuatro.
  - **Id del alta:** sale de un contador de la colección `contadores`, que se incrementa con `$inc`.
    El incremento es atómico, así que dos altas simultáneas nunca reciben el mismo id (diez altas
    simultáneas recibieron diez ids distintos). Un alta rechazada después de pedir su número deja un
    hueco en la numeración. La carga deja el contador en el id más alto cargado.
  - **Modificación y baja:** el `update` filtra por el documento completo que se leyó para validar.
    Si otra escritura cambió el cliente en el medio, el filtro no lo encuentra y la operación se
    rechaza en lugar de pisar ese cambio.

**Uso** (un valor vacío, como `nro_afiliado=`, se toma como nulo):

```bash
npm run query -- 13 alta nombre=Valentina apellido=Sosa dni=41222333 email=vale.sosa@gmail.com \
  telefono=1145990011 ciudad="La Plata" provincia="Buenos Aires" obra_social=OSDE nro_afiliado=OS-412233
npm run query -- 13 modificar C019 email=valentina.sosa@outlook.com telefono=1145990022 \
  obra_social="Sin cobertura" nro_afiliado=
npm run query -- 13 baja C019
```

**Código:**

```ts
// ClientesRepository.alta: el id sale del contador; el índice único sobre dni es la garantía real
await this.rechazarSiDniRegistrado(datos.dni);
const cliente: Cliente = { _id: formatearId("C", await siguienteNumero(this.db, "clientes")), ...datos, activo: true };
await this.coleccion.insertOne(cliente); // E11000 sobre dni → OperacionRechazada
await this.copiar(cliente); // MERGE (c:Cliente {id_cliente: $nodo.id_cliente}) SET c = $nodo

// ClientesRepository.actualizar: aplica el cambio solo si el cliente sigue como se validó
const despues = await this.coleccion.findOneAndUpdate(antes, { $set: cambios }, { returnDocument: "after" });
if (!despues) throw new OperacionRechazada(`el cliente ${antes._id} cambió mientras se procesaba la operación; ...`);
await this.copiar(despues);
```

**Estado antes / después.** Salidas reales sobre los datos de `npm run seed`. Antes del alta, C019
no existe en ninguno de los dos motores (la carga dejó el contador de clientes en C018, el id más
alto de los 18 clientes cargados). Después de cada operación se muestra también el nodo `(:Cliente)`
de Neo4j, consultado con Cypher desde un script que usa el driver del proyecto.

Alta:

```json
{
  "antes": null,
  "despues": {
    "_id": "C019",
    "nombre": "Valentina",
    "apellido": "Sosa",
    "dni": "41222333",
    "email": "vale.sosa@gmail.com",
    "telefono": "1145990011",
    "ciudad": "La Plata",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-412233",
    "activo": true
  }
}
```

```text
email, telefono, obra_social, nro_afiliado, activo
"vale.sosa@gmail.com", "1145990011", "OSDE", "OS-412233", TRUE
```

Modificación de contacto y cobertura (pasa a 'Sin cobertura' y vacía el número de afiliado):

```json
{
  "antes": {
    "_id": "C019",
    "nombre": "Valentina",
    "apellido": "Sosa",
    "dni": "41222333",
    "email": "vale.sosa@gmail.com",
    "telefono": "1145990011",
    "ciudad": "La Plata",
    "provincia": "Buenos Aires",
    "obra_social": "OSDE",
    "nro_afiliado": "OS-412233",
    "activo": true
  },
  "despues": {
    "_id": "C019",
    "nombre": "Valentina",
    "apellido": "Sosa",
    "dni": "41222333",
    "email": "valentina.sosa@outlook.com",
    "telefono": "1145990022",
    "ciudad": "La Plata",
    "provincia": "Buenos Aires",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": true
  }
}
```

```text
email, telefono, obra_social, nro_afiliado, activo
"valentina.sosa@outlook.com", "1145990022", "Sin cobertura", NULL, TRUE
```

Baja lógica:

```json
{
  "antes": {
    "_id": "C019",
    "nombre": "Valentina",
    "apellido": "Sosa",
    "dni": "41222333",
    "email": "valentina.sosa@outlook.com",
    "telefono": "1145990022",
    "ciudad": "La Plata",
    "provincia": "Buenos Aires",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": true
  },
  "despues": {
    "_id": "C019",
    "nombre": "Valentina",
    "apellido": "Sosa",
    "dni": "41222333",
    "email": "valentina.sosa@outlook.com",
    "telefono": "1145990022",
    "ciudad": "La Plata",
    "provincia": "Buenos Aires",
    "obra_social": "Sin cobertura",
    "nro_afiliado": null,
    "activo": false
  }
}
```

```text
email, telefono, obra_social, nro_afiliado, activo
"valentina.sosa@outlook.com", "1145990022", "Sin cobertura", NULL, FALSE
```

**Casos de rechazo.** Ninguno modifica datos, y el comando termina con código 1:

```text
$ npm run query -- 13 alta nombre=Pedro apellido=Ruiz dni=31245678 ... obra_social=PAMI nro_afiliado=PA-1
Rechazado: ya existe un cliente con DNI 31245678: C001 (activo)

$ npm run query -- 13 alta nombre=Hugo apellido=Mansilla dni=25678901 ... obra_social="Sin cobertura"
Rechazado: ya existe un cliente con DNI 25678901: C008 (dado de baja)

$ npm run query -- 13 alta nombre=Ana apellido=Paz dni=12AB email=ana-sin-arroba telefono=11-4444 ... obra_social=OSDE
Rechazado: dni "12AB" tiene que tener 7 u 8 dígitos; email "ana-sin-arroba" no es válido; telefono "11-4444" tiene que tener solo dígitos (6 a 15); con obra social OSDE, falta nro_afiliado

$ npm run query -- 13 modificar C001 obra_social="Sin cobertura"
Rechazado: con 'Sin cobertura', nro_afiliado tiene que quedar vacío

$ npm run query -- 13 modificar C001 dni=99999999
Rechazado: "dni=99999999" no es válido: se espera campo=valor, sin repetir, con campo en email, telefono, obra_social, nro_afiliado

$ npm run query -- 13 baja C019
Rechazado: el cliente C019 está dado de baja
```

### Q14: Registro de una venta 'Completada' con validaciones y actualización de receta

- **Tipo:** Servicio · **Parámetros:** `id_cliente`, `id_farmaceutico`, `medio_pago`, `id_receta`
  (opcional) y los ítems (`id_producto` y cantidad de cada uno) · **Módulo:** `src/queries/q14.ts`
- **Motores:** MongoDB (colecciones `ventas`, `recetas`, `lotes`, `clientes`, `productos` y
  `contadores`) y Neo4j (el farmacéutico y su sucursal, cuya única copia está en el grafo, y las
  copias de la venta, de la receta y de los lotes).
- **Resolución de relaciones:** combinación en la aplicación. El cliente, los productos y la receta
  se leen de MongoDB por id; el farmacéutico y su sucursal se leen de Neo4j con el patrón
  `(:Farmaceutico {id_farmaceutico: $id})-[:TRABAJA_EN]->(:Sucursal)`. La venta guarda las
  referencias por id y los ítems embebidos.
- **Validaciones** (todas antes de escribir; si una no pasa, lanza `OperacionRechazada` y no se
  modifica ningún dato):
  - cliente existente y activo (se vuelve a confirmar dentro de la transacción, §8);
  - farmacéutico existente, activo y de una sucursal de tipo 'Farmacia';
  - medio de pago entre los admitidos por el enunciado;
  - al menos un ítem, sin productos repetidos y con cantidades enteras positivas;
  - productos existentes y activos;
  - si algún producto es 'Bajo receta' o 'Bajo receta archivada': receta existente, 'Vigente' y del
    mismo cliente. Si se indica una receta pero ningún producto la requiere, la venta se rechaza,
    para no consumir una dispensa sin uso.
- **Armado de la venta:** fecha de hoy (fecha del sistema); cada ítem toma el precio de lista vigente
  del producto; el total es la suma de cantidad × precio de los ítems; el tipo es 'Con receta' si
  hay receta y 'Venta libre' si no. Los ids de la venta y de cada ítem salen de los contadores
  `ventas` y `detalle_ventas` de la colección `contadores` (`$inc` atómico), que la carga deja en el
  id más alto cargado.
- **Escritura:** en una única transacción de MongoDB se inserta la venta, se registra la dispensa de
  la receta y se descuenta el stock con q15 (FEFO, sin lotes vencidos). Si el stock no alcanza para
  algún ítem, la transacción se descarta: no queda la venta ni la receta modificada (§8). La
  dispensa aplica las reglas de negocio: suma una dispensa; si quedan dispensas autorizadas, la
  próxima se fija 30 días después; si no, la receta pasa a 'Completada' y `proxima_dispensa` queda
  vacía (las recetas simples y archivadas se completan con su única dispensa). Después de confirmar
  la transacción se escriben las copias de la receta, de la venta y de los lotes en Neo4j.

**Uso** (cada ítem va como `id_producto:cantidad`):

```bash
npm run query -- 14 C001 F001 Efectivo PRD001:2 PRD011:1
npm run query -- 14 C003 F005 Débito receta=RC002 PRD008:1
```

**Código:**

```ts
// q14RegistrarVenta: primero todas las validaciones, sin escribir nada
const medioPago = medioDePago(datos.medio_pago);
rechazarSiItemsInvalidos(datos.items);
await rechazarSiClienteNoActivo(clientes, datos.id_cliente);
await rechazarSiFarmaceuticoNoHabilitado(farmaceuticos, datos.id_farmaceutico);
const catalogo = await productosActivos(productos, datos.items);
const receta = await recetaDeLaVenta(recetas, datos.id_receta, datos.id_cliente, catalogo);

// venta, dispensa y descuento de stock, en una única transacción de MongoDB
const resultado = await transacciones.ejecutar(async (session) => {
  await clientes.confirmarActivo(datos.id_cliente, session); // sigue activo: { _id, activo: true }, $inc version (§8)
  const venta = await ventas.registrar({ ...cabecera, total, estado: "Completada", items, stock_descontado: false }, session);
  const dispensa = receta
    ? { antes: receta, despues: await recetas.dispensar(receta, fecha, session) }
    : null;
  const stock = await descontarStockDeVenta({ ventas, farmaceuticos, lotes }, venta._id, session); // q15
  return { venta: stock.venta, receta: dispensa, lotes: stock.lotes };
});
// después de confirmar, las copias en Neo4j
if (resultado.receta) await recetas.copiar(resultado.receta.despues); // MERGE (:Receta)
await ventas.copiar(resultado.venta); // MERGE (:Venta) + ATENDIDA_POR, DE_CLIENTE, CON_RECETA e INCLUYE
await lotes.copiarUnidades(resultado.lotes.map((lote) => lote.despues));

// RecetasRepository.dispensar: reglas de tratamiento prolongado
const dispensasRealizadas = receta.dispensas_realizadas + 1;
const completa = receta.tipo !== "Tratamiento prolongado" || dispensasRealizadas >= receta.dispensas_autorizadas;
await this.coleccion.updateOne(
  { _id: receta._id, estado: "Vigente", dispensas_realizadas: receta.dispensas_realizadas },
  { $set: { dispensas_realizadas: dispensasRealizadas,
            proxima_dispensa: completa ? null : sumarDias(fecha, 30),
            estado: completa ? "Completada" : "Vigente" } },
  { session },
);
```

**Estado antes / después.** Salidas reales, ejecutadas en este orden después de `npm run seed`, el
15/11/2026. Antes de la primera venta, la última venta cargada es V026 y el último ítem D034; RC002
es una receta de tratamiento prolongado de C003 con 2 de 3 dispensas realizadas, y F005 trabaja en
S003, donde el único lote de PRD008 (L010) tiene 12 unidades.

Venta con la última dispensa de RC002 (la receta pasa a 'Completada' y L010 baja de 12 a 11):

```text
$ npm run query -- 14 C003 F005 Débito receta=RC002 PRD008:1
```

```json
{
  "venta": {
    "_id": "V027",
    "id_cliente": "C003",
    "id_farmaceutico": "F005",
    "id_receta": "RC002",
    "fecha": "2026-11-15T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Débito",
    "total": 7300,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D035",
        "id_producto": "PRD008",
        "cantidad": 1,
        "precio_unit": 7300
      }
    ],
    "stock_descontado": true
  },
  "receta": {
    "antes": {
      "_id": "RC002",
      "id_cliente": "C003",
      "medico": "Dra. Silvia Montenegro",
      "matricula_medico": "MP-39877",
      "fecha_emision": "2026-07-15T00:00:00.000Z",
      "tipo": "Tratamiento prolongado",
      "dispensas_autorizadas": 3,
      "dispensas_realizadas": 2,
      "proxima_dispensa": "2026-09-15T00:00:00.000Z",
      "estado": "Vigente"
    },
    "despues": {
      "_id": "RC002",
      "id_cliente": "C003",
      "medico": "Dra. Silvia Montenegro",
      "matricula_medico": "MP-39877",
      "fecha_emision": "2026-07-15T00:00:00.000Z",
      "tipo": "Tratamiento prolongado",
      "dispensas_autorizadas": 3,
      "dispensas_realizadas": 3,
      "proxima_dispensa": null,
      "estado": "Completada"
    }
  },
  "lotes": [
    {
      "antes": {
        "_id": "L010",
        "id_producto": "PRD008",
        "id_sucursal": "S003",
        "nro_lote": "L-2507P",
        "unidades": 12,
        "vencimiento": "2027-01-31T00:00:00.000Z"
      },
      "despues": {
        "_id": "L010",
        "id_producto": "PRD008",
        "id_sucursal": "S003",
        "nro_lote": "L-2507P",
        "unidades": 11,
        "vencimiento": "2027-01-31T00:00:00.000Z"
      }
    }
  ]
}
```

Las copias en Neo4j, consultadas con Cypher (la venta con sus relaciones, su ítem, la receta y el
lote):

```text
v.id_venta, v.fecha, v.tipo, v.total, v.estado, f.id_farmaceutico, c.id_cliente, r.id_receta
"V027", 2026-11-15, "Con receta", 7300, "Completada", "F005", "C003", "RC002"
i.id_detalle, p.id_producto, i.cantidad, i.precio_unit
"D035", "PRD008", 1, 7300
r.id_receta, r.dispensas_realizadas, r.proxima_dispensa, r.estado
"RC002", 3, NULL, "Completada"
l.id_lote, l.unidades
"L010", 11
```

Venta con una receta a la que le quedan dispensas (RC004, de C006, con 1 de 3 realizadas): la
próxima dispensa se fija 30 días después de hoy. Extracto de la salida, con los campos que cambian:

```text
$ npm run query -- 14 C006 F005 "Obra social" receta=RC004 PRD008:1
```

```json
{
  "venta": {
    "_id": "V028",
    "id_receta": "RC004",
    "total": 7300,
    "stock_descontado": true
  },
  "receta": {
    "antes": {
      "dispensas_autorizadas": 3,
      "dispensas_realizadas": 1,
      "proxima_dispensa": "2026-10-20T00:00:00.000Z",
      "estado": "Vigente"
    },
    "despues": {
      "dispensas_autorizadas": 3,
      "dispensas_realizadas": 2,
      "proxima_dispensa": "2026-12-15T00:00:00.000Z",
      "estado": "Vigente"
    }
  },
  "lotes": [
    {
      "antes": {
        "_id": "L010",
        "unidades": 11
      },
      "despues": {
        "_id": "L010",
        "unidades": 10
      }
    }
  ]
}
```

**Casos de rechazo.** Ejecutados a continuación. Cada uno termina con código 1. Los dos últimos pasan
todas las validaciones de datos, pero no hay stock vigente suficiente y la transacción se descarta
completa. En S003 solo hay 18 unidades vigentes de PRD001. En S004 hay 75 unidades vigentes de PRD003
(L006): el lote L030, de 30 unidades, venció el 31/08/2026 y no se cuenta.

```text
$ npm run query -- 14 C001 F007 Efectivo PRD001:1
Rechazado: el farmacéutico F007 trabaja en S005 (Droguería), y solo se registran ventas en sucursales de tipo 'Farmacia'
$ npm run query -- 14 C001 F001 Efectivo receta=RC006 PRD008:1
Rechazado: la receta RC006 es de otro cliente (C007)
$ npm run query -- 14 C001 F001 Efectivo PRD013:1
Rechazado: el producto PRD013 está discontinuado
$ npm run query -- 14 C003 F005 Débito receta=RC002 PRD008:1
Rechazado: la receta RC002 no está vigente (Completada)
$ npm run query -- 14 C006 F005 "Obra social" receta=RC004 PRD008:1 PRD001:20
Rechazado: stock vigente insuficiente de PRD001 en S003: se piden 20 unidades y hay 18
$ npm run query -- 14 C015 F001 Efectivo PRD001:1
Rechazado: el cliente C015 está dado de baja
$ npm run query -- 14 C001 F014 Efectivo PRD001:1
Rechazado: el farmacéutico F014 no está activo
$ npm run query -- 14 C014 F008 "Obra social" receta=RC014 PRD015:1
Rechazado: la receta RC014 no está vigente (Vencida)
$ npm run query -- 14 C006 F006 "Obra social" receta=RC004 PRD003:76
Rechazado: stock vigente insuficiente de PRD003 en S004: se piden 76 unidades y hay 75
```

Después de los rechazos no cambió ningún dato: la copia de Neo4j tiene 28 ventas (las 26
cargadas, V027 y V028), RC004 sigue con 2 dispensas realizadas y la próxima el 15/12/2026 (`npm run
query -- 3 C006`), y los lotes L003 (PRD001) y L010 (PRD008) siguen en 18 y 10 unidades. Los rechazos
por stock insuficiente ya habían pedido sus ids a los contadores (`ventas` y `detalle_ventas`):
esos ids quedan sin usar, igual que con un alta de cliente rechazada (Q13).

### Q15: Descuento masivo de stock de una venta (FEFO, sin lotes vencidos, todo o nada)

- **Tipo:** Servicio · **Parámetros:** `id_venta` · **Módulo:** `src/queries/q15.ts`
- **Motores:** MongoDB (colecciones `ventas` y `lotes`, fuente de verdad del stock) y Neo4j (la
  sucursal del farmacéutico, cuya única copia está en el grafo, y la copia de los lotes en los nodos
  `(:Lote)`, que lee q08).
- **Resolución de relaciones:** combinación en la aplicación. La venta se lee de MongoDB con sus
  ítems embebidos; la sucursal se obtiene recorriendo `(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)`
  desde el farmacéutico de la venta; los lotes se buscan en MongoDB por sucursal y producto, con el
  índice `{id_sucursal: 1, id_producto: 1, vencimiento: 1}`.
- **Validaciones:** la venta existe; está 'Completada' (una venta 'Pendiente' o 'Anulada' no
  descuenta stock, §2.11 del enunciado); su stock no se descontó antes (campo `stock_descontado`);
  y el stock vigente de la sucursal alcanza para cada ítem.
- **Descuento:** para cada producto toma los lotes de la sucursal con unidades y vencimiento igual o
  posterior a hoy, ordenados por vencimiento (FEFO), y reparte la cantidad entre ellos. Primero
  calcula el descuento completo; si para algún producto no alcanza, rechaza la operación sin
  modificar ningún lote. Recién entonces escribe: cada `update` usa `$inc` con un filtro que exige
  unidades suficientes, y la venta se marca con `stock_descontado: true`. Todo dentro de una
  transacción de MongoDB; después de confirmarla se actualizan las unidades de los nodos `(:Lote)`.
- **Integración con q14:** q14 ejecuta la misma función (`descontarStockDeVenta`) dentro de su
  transacción, así que una venta registrada con q14 ya tiene su stock descontado y q15 no la vuelve
  a descontar (§8).

**Uso:**

```bash
npm run query -- 15 V003
```

**Código:**

```ts
// q15: la parte transaccional (la misma que usa q14) y, después de confirmar, la copia en Neo4j
const resultado = await transacciones.ejecutar((session) => descontarStockDeVenta(repos, idVenta, session));
await lotes.copiarUnidades(resultado.lotes.map((lote) => lote.despues));

// LotesRepository.descontarFefo: lotes vigentes ordenados por vencimiento
const vigentes = await this.coleccion
  .find({ id_sucursal: idSucursal, id_producto: { $in: productos }, vencimiento: { $gte: hoy }, unidades: { $gt: 0 } }, { session })
  .sort({ vencimiento: 1, _id: 1 })
  .toArray();
const descuentos = planDeDescuento(vigentes, items, idSucursal); // si no alcanza: OperacionRechazada
for (const { lote, unidades } of descuentos) {
  const { matchedCount } = await this.coleccion.updateOne(
    { _id: lote._id, unidades: { $gte: unidades } }, // el stock nunca queda negativo
    { $inc: { unidades: -unidades } },
    { session },
  );
  if (matchedCount === 0) throw new OperacionRechazada(`el lote ${lote._id} cambió mientras se descontaba el stock; ...`);
}
```

**Estado antes / después.** Salidas reales sobre los datos de `npm run seed`, el 15/11/2026. V003 es
una venta 'Completada' de un ítem de PRD003 atendida por F001, que trabaja en S001. En S001 hay dos
lotes de PRD003: L005 (40 unidades, vence el 30/11/2026) y L015 (100 unidades, vence el 30/06/2027).
FEFO elige L005, el que vence antes:

```text
$ npm run query -- 15 V003
```

```json
{
  "venta": {
    "_id": "V003",
    "id_cliente": "C001",
    "id_farmaceutico": "F001",
    "id_receta": "RC001",
    "fecha": "2026-09-10T00:00:00.000Z",
    "tipo": "Con receta",
    "medio_pago": "Obra social",
    "total": 9800,
    "estado": "Completada",
    "items": [
      {
        "id_detalle": "D004",
        "id_producto": "PRD003",
        "cantidad": 1,
        "precio_unit": 9800
      }
    ],
    "stock_descontado": true
  },
  "lotes": [
    {
      "antes": {
        "_id": "L005",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2506A",
        "unidades": 40,
        "vencimiento": "2026-11-30T00:00:00.000Z"
      },
      "despues": {
        "_id": "L005",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2506A",
        "unidades": 39,
        "vencimiento": "2026-11-30T00:00:00.000Z"
      }
    }
  ]
}
```

La copia en Neo4j, consultada con Cypher:

```text
l.id_lote, l.unidades
"L005", 39
"L015", 100
```

Cuando un ítem no entra en un solo lote, el descuento se reparte en orden de vencimiento. Por
ejemplo, una venta de 50 unidades de PRD003 en S001, registrada con q14 a continuación (extracto con
la venta y los lotes): L005 se agota y las 11 unidades restantes salen de L015.

```text
$ npm run query -- 14 C006 F001 Débito receta=RC003 PRD003:50
```

```json
{
  "venta": {
    "_id": "V027",
    "id_receta": "RC003",
    "total": 490000,
    "stock_descontado": true
  },
  "lotes": [
    {
      "antes": {
        "_id": "L005",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2506A",
        "unidades": 39,
        "vencimiento": "2026-11-30T00:00:00.000Z"
      },
      "despues": {
        "_id": "L005",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2506A",
        "unidades": 0,
        "vencimiento": "2026-11-30T00:00:00.000Z"
      }
    },
    {
      "antes": {
        "_id": "L015",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2601B",
        "unidades": 100,
        "vencimiento": "2027-06-30T00:00:00.000Z"
      },
      "despues": {
        "_id": "L015",
        "id_producto": "PRD003",
        "id_sucursal": "S001",
        "nro_lote": "L-2601B",
        "unidades": 89,
        "vencimiento": "2027-06-30T00:00:00.000Z"
      }
    }
  ]
}
```

```text
l.id_lote, l.unidades
"L005", 0
"L015", 89
```

**Casos de rechazo.** Ejecutados después de la primera ejecución sobre V003. V012 está 'Pendiente' y
V025 está 'Anulada'. V010 vende una unidad de PRD010 en S002: el único lote de PRD010 en S002, L012,
tiene 30 unidades pero venció el 31/10/2026, así que no cuenta como stock vigente. En V001 no hay
ningún lote de PRD007 en S002. En todos los casos ningún lote cambia.

```text
$ npm run query -- 15 V003
Rechazado: el stock de la venta V003 ya se descontó
$ npm run query -- 15 V012
Rechazado: la venta V012 está 'Pendiente': solo una venta 'Completada' descuenta stock
$ npm run query -- 15 V025
Rechazado: la venta V025 está 'Anulada': solo una venta 'Completada' descuenta stock
$ npm run query -- 15 V010
Rechazado: stock vigente insuficiente de PRD010 en S002: se pide 1 unidad y hay 0
$ npm run query -- 15 V001
Rechazado: stock vigente insuficiente de PRD007 en S002: se pide 1 unidad y hay 0
```

**Una venta de los registros adicionales.** V021 (C014, atendida por F008 en la Farmacia Recoleta,
S006) tiene dos ítems: 2 unidades de PRD014 y 1 de PRD001. Cada producto se descuenta de su lote en
S006 (L019 y L027), y la venta queda marcada con `stock_descontado: true` (extracto):

```text
$ npm run query -- 15 V021
```

```json
{
  "venta": {
    "_id": "V021",
    "id_farmaceutico": "F008",
    "total": 9000,
    "stock_descontado": true
  },
  "lotes": [
    {
      "antes": {
        "_id": "L019",
        "id_producto": "PRD014",
        "id_sucursal": "S006",
        "unidades": 85
      },
      "despues": {
        "_id": "L019",
        "id_producto": "PRD014",
        "id_sucursal": "S006",
        "unidades": 83
      }
    },
    {
      "antes": {
        "_id": "L027",
        "id_producto": "PRD001",
        "id_sucursal": "S006",
        "unidades": 300
      },
      "despues": {
        "_id": "L027",
        "id_producto": "PRD001",
        "id_sucursal": "S006",
        "unidades": 299
      }
    }
  ]
}
```

```text
l.id_lote, l.unidades
"L019", 83
"L027", 299
```


---

## 8. Consistencia en los servicios de escritura (q14 y q15)

El enunciado pide que q14 y q15 funcionen juntos: si el descuento de stock falla, no puede quedar una
venta registrada ni una receta modificada. Ventas, recetas y lotes tienen su fuente de verdad en
MongoDB (§2.2, punto 4), así que la estrategia elegida es una **transacción multi-documento de
MongoDB** que abarca esas tres colecciones y, para confirmar que el cliente sigue activo, también
`clientes`. No hace falta coordinar dos motores ni compensar escrituras ya confirmadas: o se
confirma todo o no se confirma nada.

**Orden de las operaciones en q14:**

1. **Validaciones, sin escribir.** Cliente, farmacéutico y sucursal, productos y receta. Si alguna no
   pasa, la venta se rechaza antes de empezar la transacción.
2. **Ids.** El id de la venta y los de sus ítems se piden a los contadores con `$inc`, fuera de la
   transacción: si la transacción se descarta, esos números quedan sin usar.
3. **Transacción de MongoDB** (`TransaccionesMongo.ejecutar`, que usa `withTransaction` del driver):
   1. se confirma que el cliente sigue activo (`ClientesRepository.confirmarActivo`), con un
      `updateOne` filtrado por `{_id, activo: true}` que incrementa `version`;
   2. se inserta la venta, con `stock_descontado: false`;
   3. se registra la dispensa de la receta, si la hay;
   4. se descuenta el stock con la parte transaccional de q15 (`descontarStockDeVenta`): lee la venta
      dentro de la misma sesión, calcula el descuento FEFO completo, actualiza los lotes y marca la
      venta con `stock_descontado: true`.

   Si cualquiera de estos pasos lanza un error, por ejemplo `OperacionRechazada` por stock
   insuficiente, la transacción se aborta y ningún cambio queda escrito. El rechazo integrado de
   Q14 lo muestra: con 20 unidades pedidas y 18 vigentes, no quedó la venta, la receta no cambió y
   los lotes tampoco.
4. **Copias en Neo4j, después de confirmar.** Se escriben el nodo `(:Receta)` (si hubo dispensa), el
   nodo `(:Venta)` con sus relaciones y sus ítems, y las unidades de los nodos `(:Lote)`. Neo4j no participa en la transacción (§2.3). Si esta escritura
   falla, la venta y el stock ya quedaron confirmados en MongoDB: el servicio lo informa y
   `npm run sync` reconstruye las copias desde MongoDB (§3.3, punto 3). Hasta entonces, las consultas
   que leen el grafo (por ejemplo q08) pueden mostrar datos desfasados.

q15 ejecutada sola sigue el mismo esquema: abre su propia transacción para la parte que escribe en
MongoDB y después actualiza la copia de los lotes.

**Escrituras concurrentes.** Las validaciones sobre datos que otro servicio puede modificar al mismo
tiempo no dependen solo de la lectura previa: se repiten dentro de la transacción, como filtro de una
escritura. El farmacéutico, su sucursal y los productos se validan solo con la lectura previa porque
ningún servicio los modifica (§2.3), así que no pueden cambiar entre la validación y la escritura.

- **Cliente.** q14 valida que el cliente esté activo antes de empezar y lo vuelve a confirmar dentro
  de la transacción con un `updateOne` filtrado por `{_id, activo: true}`, que incrementa `version`
  (un campo técnico del documento, que las lecturas excluyen). Si una baja de q13 se confirmó entre la
  validación y la transacción, el filtro no coincide y la venta se rechaza. Si la baja llega cuando la
  transacción ya escribió el cliente, las dos operaciones escriben el mismo documento: la baja espera
  a que la transacción termine y se aplica después de la venta. En ningún caso se confirma una venta
  de un cliente que ya estaba dado de baja. Se probaron los dos casos: con la baja confirmada entre la
  validación y la transacción, la venta se rechazó ("el cliente C006 no existe o está dado de baja")
  y no se agregó ninguna venta; con la baja lanzada con la transacción abierta, la venta quedó
  registrada y la baja se aplicó después.
- **Stock.** Cada descuento filtra por `unidades >= lo que descuenta`. Además, si dos transacciones
  modifican el mismo lote a la vez, MongoDB detecta el conflicto de escritura y aborta una de ellas;
  `withTransaction` la reintenta desde el principio, así que vuelve a leer los lotes y recalcula el
  descuento con el stock actualizado. Así el stock nunca queda negativo. En una prueba con tres ventas
  simultáneas de 10 unidades de PRD001 en S003 (18 vigentes), se registró una y las otras dos se
  rechazaron con "se piden 10 unidades y hay 8"; L003 terminó en 8 unidades. El resultado fue el
  mismo en tres repeticiones.
- **Receta.** La dispensa filtra por el estado y las dispensas realizadas que se leyeron al validar:
  si otra venta dispensó la misma receta en el medio, la operación se rechaza.
- **Doble descuento de una venta.** La marca `stock_descontado` se escribe en la misma transacción
  que el descuento, con un filtro que exige que todavía esté en `false`. Una venta registrada con q14
  ya queda marcada, y q15 la rechaza si se ejecuta sobre ella.
- **Copias en Neo4j.** Las copias se escriben fuera de la transacción, así que dos ventas confirmadas
  en un orden pueden escribir sus copias en el orden inverso. Las unidades de un lote solo bajan (las
  modifica únicamente el descuento de q15), así que la copia se queda con el menor valor entre el que
  tiene el nodo y el recibido
  (`SET l.unidades = CASE WHEN fila.unidades < l.unidades THEN fila.unidades ELSE l.unidades END`):
  el resultado no depende del orden de llegada ni de repetir una copia. En una prueba, copiar 5, 6 y
  5 unidades de L010, en ese orden, dejó el nodo en 5. Con el mismo criterio, la copia de una receta
  no se reemplaza por una versión con menos dispensas realizadas.

**Alternativas descartadas.** Escribir primero la venta y descontar después el stock con
compensaciones (borrar la venta y revertir la receta si el descuento falla) dejaría ventanas en las
que otra consulta vería una venta sin su descuento de stock, y una falla entre los pasos dejaría
datos inconsistentes. Como las tres entidades están en un mismo motor con transacciones ACID, la
transacción es la opción más simple y con garantías más fuertes.

---

## 9. Limitaciones, alternativas evaluadas y conclusiones

### 9.1 Limitaciones

- **Las copias de Neo4j pueden quedar desfasadas.** Neo4j no participa en las transacciones de MongoDB
  (§2.3): la copia se escribe después de confirmar. Si esa escritura falla, la venta y el stock ya
  están confirmados y las consultas que leen el grafo, como q03 y q08, muestran datos viejos hasta
  correr `npm run sync`. No hay una reconciliación automática. Las copias de lotes y recetas toleran
  que dos escrituras lleguen en otro orden (§8); la de un cliente no: si dos modificaciones del mismo
  cliente se confirman casi a la vez y sus copias llegan en el orden inverso, el nodo queda con la
  anterior hasta `npm run sync`.
- **`npm run seed` descarta lo escrito por los servicios.** Como la carga reemplaza cada entidad
  completa (§6.1), las altas de cliente y las ventas registradas con q13 y q14 se pierden al volver a
  cargar. Es el costo de que sea idempotente.
- **Los ids de los contadores pueden tener huecos.** Se piden fuera de la transacción: un alta de
  cliente o una venta rechazada deja un número sin usar (§8).
- **Las fechas de los registros adicionales son fijas.** Las consultas calculan "hoy" con la fecha del
  sistema: pasado noviembre de 2026, q11 no encuentra ventas del mes y los lotes próximos a vencer ya
  estarán vencidos (§6.2).
- **Entorno de un solo nodo.** El replica set `rs0` tiene un único nodo, suficiente para tener
  transacciones, pero sin tolerancia a fallas. Neo4j tampoco está en cluster.
- **Datos de referencia sin servicio de escritura.** Proveedores, sucursales y farmacéuticos solo se
  modifican con la carga: cambiar uno requiere editar el CSV y volver a cargar.
- **Los repositorios exponen operaciones a medida.** Una consulta nueva puede requerir un método
  nuevo (§3.4).

### 9.2 Alternativas evaluadas

- **Todo en MongoDB, sin Neo4j.** Es posible resolver las consultas con `$lookup`, y habría una sola
  base y ninguna copia que mantener. Elegimos sumar Neo4j porque varias consultas (q01, q02, q03, q05,
  q08, q10, q12) son recorridos de relaciones que en el grafo se escriben como el patrón que
  describen, y porque la red cliente–receta–venta–producto que recorre el historial queda explícita
  en el modelo, en lugar de reconstruirse con uniones en cada consulta (§2.3).
- **Todo en Neo4j, sin MongoDB.** Evitaría las copias, pero las ventas con ítems de cantidad variable
  encajan mejor en un documento, y q14 y q15 necesitan una transacción sobre ventas, recetas, stock y clientes
  con actualizaciones atómicas condicionadas, que resolvemos en un único motor con MongoDB (§2.2,
  puntos 4 y 5).
- **Redis (clave-valor).** Sirve para datos de referencia y rankings, pero accede solo por clave: las
  consultas por cliente, estado o rango de fechas obligarían a mantener a mano un índice por cada
  criterio (§2.2, punto 2).
- **Un motor columnar para reportes.** Los reportes (q04, q05, q07, q11) trabajan con el volumen de
  una red de farmacias y se resuelven con *aggregation pipelines* (q04, q07, q11) o con una
  agregación sobre el grafo (q05); un motor columnar sumaría un tercer
  sistema que mantener sin una necesidad clara.
- **Detalle de venta en una colección aparte.** Evita documentos grandes, pero obliga a leer y
  escribir en dos lugares cada venta y a mantener la consistencia entre ellos. Con una cantidad
  acotada de ítems por venta, preferimos embebido (§4.1).
- **Descontar el stock después de registrar la venta, con compensaciones.** Deja ventanas con datos
  inconsistentes y requiere deshacer a mano; descartada a favor de la transacción de MongoDB (§8).

### 9.3 Conclusiones

La persistencia políglota nos permitió asignar cada entidad al motor que mejor resuelve sus consultas:
MongoDB como base central, con transacciones ACID para las escrituras que deben ser consistentes, y
Neo4j para las consultas que recorren relaciones. El costo es mantener copias de algunas entidades en
los dos motores, y lo acotamos con una organización del código por dominio: un único tipo por entidad
y un único repositorio que escribe siempre primero en MongoDB y después en Neo4j (§3).

Los puntos más importantes del diseño son la transacción que une q14 y q15 (§8), que evita ventas sin
descuento de stock, la validación completa de los datos antes de cargar (§5 y §6) y la carga
idempotente, que permite reconstruir el entorno en cualquier momento. Como mejora a futuro, la
reconciliación automática de las copias de Neo4j y un servicio de escritura para los datos de
referencia cerrarían las limitaciones más relevantes.
