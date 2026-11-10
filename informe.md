# FarmaRed: Sistema de Gestión de Red de Farmacias

**Base de Datos II · Trabajo Práctico Obligatorio · 2.º cuatrimestre 2026**

**Grupo:** 18

| Integrante | Legajo |
| ---------- | ------ |
| Rocco Perrone   | 65628  |
| TODO       | TODO   |
| TODO       | TODO   |
| TODO       | TODO   |

**Repositorio:** TODO (link a GitHub)

> **TODO:** completar la carátula con los integrantes y el link al repositorio (enunciado §5.2).

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

> **TODO:** presentar el problema en dos o tres párrafos: FarmaRed S.A., migración del backoffice desde
> planillas de cálculo a una arquitectura de persistencia políglota, entidades que se gestionan y
> alcance de este trabajo (15 consultas y servicios, carga de datos y entorno en Codespaces).

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
2. **Consultas por atributos.** Ventas, recetas y clientes se consultan por cliente, por farmacéutico,
   por estado y por rango de fechas. MongoDB admite índices secundarios, simples y compuestos, sobre
   cualquier campo. Un almacén clave-valor solo accede por clave: cada uno de esos criterios
   obligaría a mantener a mano un índice aparte.
3. **Reportes agregados.** Los totales por farmacéutico, los rankings de productos y los conteos por
   período (q04, q05, q07, q11) se expresan como *aggregation pipelines* (`$match`, `$group`, `$sort`,
   `$lookup`). Se ejecutan en el servidor y solo devuelven el resultado.
4. **Consistencia en escrituras de varias entidades.** El servicio de registro de venta (q14) y el de
   descuento de stock (q15) tienen que funcionar juntos: si el descuento de stock falla, no puede quedar
   ni la venta registrada ni la receta modificada. MongoDB ofrece transacciones ACID sobre varios
   documentos y colecciones. Por eso guardamos en MongoDB todas las entidades que esas escrituras tocan
   (ventas, recetas y stock), y la operación se resuelve con una transacción en un único motor. Así no
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
2. **El recorrido completo se resuelve en el servidor, en un viaje.** Desde cada nodo, Neo4j sigue
   sus relaciones directamente hasta los nodos vecinos. La aplicación no tiene que pedir una entidad,
   juntar los ids de sus referencias y volver a pedir las entidades relacionadas: q08 se resuelve en
   un solo viaje, cuando combinando en la aplicación necesitaría tres (lotes, sus productos y, al
   final, sucursales y proveedores).
3. **Las relaciones no quedan colgadas.** Una relación siempre une dos nodos que existen: no se puede
   crear hacia un nodo inexistente, y un nodo no se puede borrar sin borrar sus relaciones
   (`DETACH DELETE`). Además, la carga verifica que cada producto y cada lote hayan quedado unidos a
   sus nodos relacionados (§3.3, punto 6).
4. **Tipos nativos.** Neo4j guarda booleanos, enteros y fechas (`date`) como tales, así que, por
   ejemplo, el vencimiento de un lote se compara y se ordena como fecha dentro del grafo.

En cuanto al alcance: en recorridos cortos y de profundidad fija, como los de estas consultas (uno a
tres saltos), llegar a cada vecino no es más rápido que una búsqueda por índice en MongoDB. La ventaja
está en los puntos 1 y 2: el recorrido entero se expresa como un patrón y se resuelve en el motor.

Esta decisión también fija qué **no** hace Neo4j:

- **No participa en las transacciones de q14 y q15.** Ventas, recetas y stock se escriben en MongoDB
  (§2.2, punto 4). Las entidades cuya fuente de verdad es MongoDB y que además se recorren en el
  grafo (hoy, productos, lotes, clientes y ventas) tienen en Neo4j una **copia**. La copia se escribe después de que
  MongoDB confirma la escritura y, si queda desfasada, se reconstruye desde MongoDB con `npm run sync`
  (§3.3, punto 3).
  Por ejemplo, q15 descuenta unidades de los lotes en MongoDB y después actualiza la copia, que es la
  que lee q08.
- **Solo es la única copia de datos que ningún servicio escribe.** Proveedores, sucursales y
  farmacéuticos son datos de referencia: solo los escribe la carga, así que viven únicamente en Neo4j.
- **Los filtros y agregaciones que no recorren relaciones quedan en MongoDB** (q07, q09, q11), que
  los resuelve con índices y *aggregation pipelines* (§2.2, punto 3).

### 2.4 Asignación de entidades a motores

| Entidad        | Motor                    | Estructura                                                                                          | Justificación                                                                                                   | Estado       |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| proveedores    | Neo4j                    | nodo `(:Proveedor)`                                                                                 | Dato de referencia que ningún servicio escribe; se llega a él recorriendo relaciones (q01, q08)                 | Implementado |
| productos      | MongoDB + copia en Neo4j | colección `productos` (`_id` = id_producto); nodo `(:Producto)-[:PROVISTO_POR]->(:Proveedor)`       | MongoDB: TODO. Neo4j: q01 y q08 recorren sus relaciones                                                         | Implementado |
| sucursales     | Neo4j                    | nodo `(:Sucursal)`                                                                                  | Dato de referencia que ningún servicio escribe; se llega a ella recorriendo relaciones (q02, q08, q10)          | Implementado |
| farmacéuticos  | Neo4j                    | nodo `(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)`                                                   | Dato de referencia que ningún servicio escribe; se llega a él recorriendo relaciones (q02)                      | Implementado |
| clientes       | MongoDB + copia en Neo4j | colección `clientes` (`_id` = id_cliente; índice único sobre `dni`); nodo `(:Cliente)`             | MongoDB: lo escribe un servicio (q13) y lo valida q14, así que no puede tener a Neo4j como única copia (§2.3); el índice único garantiza el DNI único. Neo4j: copia para las consultas que recorren las relaciones de los clientes (q10, q12) | Implementado |
| recetas        | MongoDB                  | colección `recetas` (`_id` = id_receta)                                                             | Participa en la transacción de q14/q15 (§2.2, punto 4)                                                          | Implementado |
| ventas/detalle | MongoDB + copia en Neo4j | colección `ventas` (`_id` = id_venta; ítems embebidos en `items`); nodo `(:Venta)-[:ATENDIDA_POR]->(:Farmaceutico)` con la cabecera | MongoDB: estructura jerárquica + transacción de q14/q15 (§2.2). Neo4j: q02 recorre sus relaciones | Implementado |
| stock_lotes    | MongoDB + copia en Neo4j | colección `lotes` (`_id` = id_lote); nodo `(:Lote)` con `DE_PRODUCTO` y `EN_SUCURSAL`               | MongoDB: actualizaciones concurrentes + transacción de q14/q15 (§2.2). Neo4j: q08 recorre sus relaciones        | Implementado |

> **TODO:** completar la tabla a medida que se implementen las entidades. Si una entidad queda en los
> dos motores (en MongoDB como fuente de verdad y en Neo4j como copia para recorrer sus relaciones),
> indicarlo en la columna Motor y explicar en §3 cómo se mantiene la consistencia.

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
   las copias sin tocar MongoDB. Nunca se reconstruye MongoDB a partir de Neo4j. Así lo hacen hoy
   `ProductosRepository.reemplazarTodos`, `LotesRepository.reemplazarTodos` y
   `VentasRepository.reemplazarTodas` en la carga, y `ClientesRepository.alta` y
   `ClientesRepository.actualizar` en un servicio (q13).
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
   antes de tocar cualquier motor. Además, al escribir en el grafo productos, lotes, farmacéuticos y
   ventas, el repositorio cuenta las relaciones que creó: si alguna referencia no encontró su nodo, aborta la transacción de Neo4j y
   el grafo queda como estaba. Los servicios de escritura validan a través de los repositorios: q13
   lo hace con el de clientes (§7), y q14 y q15 van a hacer lo mismo.

### 3.4 Costos de la decisión

- Las consultas que recorren relaciones se escriben como un único patrón de Cypher, dentro del
  repositorio de la entidad donde empieza el recorrido (q01 en productos, q02 en ventas, q08 en lotes). Ese
  repositorio usa los conversores de los otros dominios (`proveedorDesdeNodo`, `sucursalDesdeNodo`)
  para devolver cada entidad con su tipo.
- Cada entidad copiada en Neo4j suma una escritura más en cada servicio que la modifica. Por ejemplo,
  q15 tiene que actualizar las unidades de los lotes en el grafo después de confirmar su transacción
  en MongoDB.
- Cada repositorio expone operaciones a medida de las consultas que lo usan, no un CRUD genérico, así
  que una consulta nueva puede requerir un método nuevo en el repositorio.

> **TODO (nota para quien continúe el informe):** en una próxima versión vamos a agregar **ejemplos
> concretos** de lo descrito en esta sección. Algunos candidatos:
>
> - un tipo de dominio guardado en los dos motores, con el método del repositorio que escribe en ambos
>   y en qué orden;
> - la conversión en el borde (`aNodo`/`productoDesdeNodo` en `src/productos/repository.ts`);
> - el error de compilación que aparece al agregar un campo al tipo sin actualizar las conversiones;
> - una escritura rechazada por una referencia inválida.
>
> Hasta entonces, esta sección describe la decisión sin ejemplos.

---

## 4. Modelo de datos

> **TODO:** describir el modelo en cada motor, con diagramas (enunciado §5.2):
>
> - **MongoDB:** colecciones, forma de los documentos (qué va embebido y qué va por referencia),
>   índices y por qué.
> - **Neo4j:** etiquetas, propiedades, relaciones (con su dirección), restricciones e índices, y qué
>   consulta recorre cada relación.
> - Un diagrama de las entidades y sus relaciones, que indique en qué motor vive cada una.

### 4.1 MongoDB

| Colección | Forma del documento                                                                                                                                                  | Índices                             | Consultas |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------- |
| `ventas`  | `_id` (id_venta), `id_cliente`, `id_farmaceutico`, `id_receta` (`null` en ventas libres), `fecha`, `tipo`, `medio_pago`, `total`, `estado` e `items` embebidos (`id_detalle`, `id_producto`, `cantidad`, `precio_unit`) | `{id_cliente: 1, fecha: 1}` (q03); `{estado: 1, fecha: 1}` (q07) | q03, q07 |
| `recetas` | `_id` (id_receta), `id_cliente`, `medico`, `matricula_medico`, `fecha_emision`, `tipo`, `dispensas_autorizadas`, `dispensas_realizadas`, `proxima_dispensa` (`null` si no corresponde), `estado` | `{id_cliente: 1, fecha_emision: 1}` (q03); `{tipo: 1, estado: 1, proxima_dispensa: 1}` (q06) | q03, q04, q06 |
| `clientes` | `_id` (id_cliente), `nombre`, `apellido`, `dni`, `email`, `telefono`, `ciudad`, `provincia`, `obra_social`, `nro_afiliado` (`null` si no tiene cobertura), `activo` | `{dni: 1}` único | q03, q04 y q06 (`$lookup`), q13 |
| `productos` | `_id` (id_producto), `nombre`, `principio_activo`, `categoria`, `presentacion`, `condicion_venta`, `precio_unit`, `id_proveedor`, `activo` | (solo `_id`) | q07 (`$lookup`) |
| `contadores` | `_id` (nombre de la entidad, por ejemplo `clientes`), `ultimo` (último número de id asignado) | (solo `_id`) | q13 (id de cada alta) |

Los ítems de cada venta van embebidos porque se leen y se escriben junto con su cabecera (§2.2, punto 1).

> **TODO:** agregar la colección `lotes`.

### 4.2 Neo4j

Relaciones implementadas hasta ahora:

```text
(:Producto)-[:PROVISTO_POR]->(:Proveedor)      q01, q08
(:Lote)-[:DE_PRODUCTO]->(:Producto)            q08
(:Lote)-[:EN_SUCURSAL]->(:Sucursal)            q08
(:Farmaceutico)-[:TRABAJA_EN]->(:Sucursal)     q02
(:Venta)-[:ATENDIDA_POR]->(:Farmaceutico)      q02
```

| Etiqueta    | Propiedades                                                                                          | Restricciones e índices                       | Origen                       |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| `Proveedor` | id_proveedor, razon_social, cuit, tipo, ciudad, provincia, telefono, activo                          | `id_proveedor` único                          | Única copia                  |
| `Sucursal`  | id_sucursal, nombre, tipo, direccion, ciudad, provincia, telefono, activo                            | `id_sucursal` único                           | Única copia                  |
| `Producto`  | id_producto, nombre, principio_activo, categoria, presentacion, condicion_venta, precio_unit, activo | `id_producto` único                           | Copia de la colección `productos` |
| `Lote`      | id_lote, nro_lote, unidades, vencimiento (`date`)                                                    | `id_lote` único; índice sobre `unidades` (q08) | Copia de la colección `lotes` |
| `Farmaceutico` | id_farmaceutico, nombre, apellido, matricula, cargo, activo                                       | `id_farmaceutico` único                       | Única copia                  |
| `Cliente`   | id_cliente, nombre, apellido, dni, email, telefono, ciudad, provincia, obra_social, nro_afiliado (ausente si no tiene cobertura), activo | `id_cliente` único | Copia de la colección `clientes` |
| `Venta`     | id_venta, fecha (`date`), tipo, medio_pago, total, estado                                            | `id_venta` único; índice sobre `estado` (q02) | Copia de la cabecera de la colección `ventas`; los ítems solo están en MongoDB |

Las referencias (`id_proveedor`, `id_producto`, `id_sucursal`, `id_farmaceutico`) no son propiedades de los nodos: son
las relaciones. Cada restricción de unicidad crea además el índice que usan las búsquedas por id.

> **TODO:** agregar el diagrama y las relaciones que falten, como las que unen ventas y clientes
> para q10 y q12.

---

## 5. Integridad referencial

> **TODO:** los motores NoSQL no garantizan integridad referencial, y el enunciado pide documentar cómo
> se resuelve (§3.3). Explicar qué se valida en la carga (ids únicos, referencias), qué se valida en
> los servicios de escritura, y qué se resuelve por modelado embebido. Apoyarse en §3.3, puntos 2 y 6.

---

## 6. Estrategia de carga de datos

> **TODO:**
>
> - Cómo funciona `npm run seed`: lee `data/provistos/` y `data/adicionales/`, valida y después
>   escribe. Por qué es idempotente.
> - Registros adicionales: el enunciado pide al menos 10 por colección. Describir qué casos borde
>   ejercitan: fechas recientes, stock bajo, lotes próximos a vencer o vencidos, recetas vencidas,
>   clientes sin compras, ventas pendientes, etc. Indicar qué consulta ejercita cada caso.

Registros adicionales incorporados hasta ahora:

| Archivo                               | Registros                 | Caso que ejercita                                                                                                                       |
| ------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `data/adicionales/ventas.csv`         | V017, V018, V019, V020    | Ventas de noviembre de 2026 (fechas recientes): el mes actual de q11 y los últimos 60 días de q05. V020 está anulada, así que q05, q09 y q11 la excluyen. V017 suma exactamente $5.000, el borde de q09 |
| `data/adicionales/detalle_ventas.csv` | D023 a D027               | Ítems de esas ventas. El total de cada venta coincide con la suma de sus ítems                                                          |

Las fechas de estos registros son fijas, y las consultas calculan "hoy" con la fecha del sistema. Si
se ejecutan en un mes posterior a noviembre de 2026, q11 no encuentra ventas del mes actual.

---

## 7. Consultas y servicios

> **TODO:** para cada consulta incluir el enunciado, el motor o los motores, cómo se resuelven las
> relaciones (embebido, referencia, combinación en la aplicación, etc.), el código o la sentencia, y
> al menos un ejemplo de resultado. Los ejemplos tienen que ser salidas reales de
> `npm run query -- <n>`. Para 13, 14 y 15 mostrar además el estado de los datos antes y después, y
> al menos un caso de rechazo por validación.

### Q01: Productos activos con todos los datos de su proveedor

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q01.ts`
- **Motores:** Neo4j (copia de productos y proveedores).
- **Resolución de relaciones:** un único patrón de Cypher,
  `(:Producto {activo: true})-[:PROVISTO_POR]->(:Proveedor)`, resuelto en el servidor en un viaje.
  El repositorio de productos reconstruye `id_proveedor` a partir de la relación.

**Código:** TODO

**Ejemplo de resultado:** TODO

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

**Ejemplo de resultado** (`npm run query -- 2`):

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
  }
]
```

### Q03: Historial completo de un cliente: ventas y recetas ordenadas cronológicamente

- **Tipo:** Lectura · **Parámetros:** `id_cliente` · **Módulo:** `src/queries/q03.ts`
- **Motores:** MongoDB (colecciones `clientes`, `ventas` y `recetas`).
- **Resolución de relaciones:** por referencia y combinación en la aplicación. `ventas` y `recetas`
  guardan `id_cliente`, y cada colección se filtra con su índice compuesto sobre cliente y fecha
  (`IXSCAN`). La aplicación une los dos resultados y los ordena por fecha. A igual fecha, la receta va
  antes que la venta. Los ítems de cada venta están embebidos, así que no requieren otra lectura. Si
  el cliente no existe, la consulta falla con un error. Un cliente sin ventas ni recetas devuelve una
  lista vacía.

**Código:**

```ts
// VentasRepository.deCliente y RecetasRepository.deCliente
this.coleccion.find({ id_cliente: idCliente }).sort({ fecha: 1, _id: 1 }).toArray();
this.coleccion.find({ id_cliente: idCliente }).sort({ fecha_emision: 1, _id: 1 }).toArray();

// q03HistorialCliente
const historial = [
  ...recetasCliente.map((receta) => ({
    registro: "receta" as const,
    fecha: receta.fecha_emision,
    ...receta,
  })),
  ...ventasCliente.map((venta) => ({ registro: "venta" as const, ...venta })),
];
return historial.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
```

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

**Ejemplo de resultado** (`npm run query -- 4`):

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

**Ejemplo de resultado** (`npm run query -- 5`, ejecutado el 10/11/2026, así que cuenta desde el
11/09/2026). F007 trabaja en la droguería, que no registra ventas, y aparece con 0. F004 no aparece
porque está inactivo. La venta anulada V015 de F002 no se cuenta.

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
    "id_farmaceutico": "F007",
    "nombre": "Romina",
    "apellido": "Acuña",
    "matricula": "MN-18401",
    "cargo": "Director Técnico",
    "id_sucursal": "S005",
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

**Ejemplo de resultado** (`npm run query -- 6`, ejecutado el 10/11/2026):

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

**Ejemplo de resultado** (`npm run query -- 7`). PRD005 y PRD011 empatan con 6 unidades. A PRD011
no le suman la venta pendiente V012 ni la anulada V020:

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
    "unidades_vendidas": 8
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
    "_id": "PRD011",
    "nombre": "Loratadina 10mg x10",
    "principio_activo": "Loratadina",
    "categoria": "Antihistamínico",
    "presentacion": "Comprimidos x10",
    "condicion_venta": "Venta libre",
    "precio_unit": 2200,
    "id_proveedor": "PRV001",
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
    "_id": "PRD009",
    "nombre": "Levotiroxina 100mcg x50",
    "principio_activo": "Levotiroxina",
    "categoria": "Hormona tiroidea",
    "presentacion": "Comprimidos x50",
    "condicion_venta": "Bajo receta",
    "precio_unit": 5900,
    "id_proveedor": "PRV003",
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

**Código:** TODO

**Ejemplo de resultado:** TODO

### Q09: Ventas 'Venta libre' con total menor a $5.000 (sin anuladas)

- **Tipo:** Lectura · **Parámetros:** ninguno · **Módulo:** `src/queries/q09.ts`
- **Motores:** TODO
- **Resolución de relaciones:** TODO

**Código:** TODO

**Ejemplo de resultado:** TODO

### Q10: Clientes atendidos en una sucursal (a través del farmacéutico de la venta, activo o no)

- **Tipo:** Lectura · **Parámetros:** `id_sucursal` · **Módulo:** `src/queries/q10.ts`
- **Motores:** TODO
- **Resolución de relaciones:** TODO

**Código:** TODO

**Ejemplo de resultado:** TODO

### Q11: Ingresos totales por farmacéutico en el mes actual (solo 'Completada')

- **Tipo:** Agregación · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q11.ts`
- **Motores:** TODO
- **Resolución de relaciones:** TODO

**Código:** TODO

**Ejemplo de resultado:** TODO

### Q12: Clientes sin ventas en el último año

- **Tipo:** Lectura · **Parámetros:** ninguno (fecha del sistema) · **Módulo:** `src/queries/q12.ts`
- **Motores:** TODO
- **Resolución de relaciones:** TODO

**Código:** TODO

**Ejemplo de resultado:** TODO

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
npm run query -- 13 modificar C009 email=valentina.sosa@outlook.com telefono=1145990022 \
  obra_social="Sin cobertura" nro_afiliado=
npm run query -- 13 baja C009
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

**Estado antes / después.** Salidas reales sobre los datos de `npm run seed`. Antes del alta, C009
no existe en ninguno de los dos motores. Después de cada operación se muestra también el nodo
`(:Cliente)` de Neo4j, consultado con `cypher-shell`.

Alta:

```json
{
  "antes": null,
  "despues": {
    "_id": "C009",
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
    "_id": "C009",
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
    "_id": "C009",
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
    "_id": "C009",
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
    "_id": "C009",
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

$ npm run query -- 13 baja C009
Rechazado: el cliente C009 está dado de baja
```

### Q14: Registro de una venta 'Completada' con validaciones y actualización de receta

- **Tipo:** Servicio · **Parámetros:** TODO · **Módulo:** `src/queries/q14.ts`
- **Motores:** TODO
- **Validaciones:** cliente existente y activo; farmacéutico existente, activo y de una sucursal
  'Farmacia'; productos existentes y activos; para productos bajo receta, receta existente, vigente
  y del mismo cliente. El total se calcula a partir de los ítems.

**Código:** TODO

**Estado antes / después:** TODO

**Caso de rechazo:** TODO

### Q15: Descuento masivo de stock de una venta (FEFO, sin lotes vencidos, todo o nada)

- **Tipo:** Servicio · **Parámetros:** `id_venta` · **Módulo:** `src/queries/q15.ts`
- **Motores:** TODO
- **Validaciones:** TODO

**Código:** TODO

**Estado antes / después:** TODO

**Caso de rechazo:** TODO (por ejemplo, stock vigente insuficiente para algún ítem)

---

## 8. Consistencia en los servicios de escritura (q14 y q15)

> **TODO:** explicar la estrategia elegida para que q14 y q15 funcionen juntos: si falla el descuento de
> stock, no puede quedar una venta registrada ni una receta modificada (enunciado §4). Partir de §2.2,
> punto 4 (transacción multi-documento en MongoDB sobre ventas, recetas y stock) y detallar el orden de
> las operaciones, cómo se evita el stock negativo ante ventas concurrentes, y cómo se actualiza la
> copia en Neo4j después de confirmar la transacción (por ejemplo, las unidades de los lotes, que lee
> q08) y qué pasa si esa actualización falla (§3.3, punto 3).

---

## 9. Limitaciones, alternativas evaluadas y conclusiones

### 9.1 Limitaciones

> **TODO**

### 9.2 Alternativas evaluadas

> **TODO:** por ejemplo, otros motores considerados (Redis como almacén clave-valor para datos de
> referencia y rankings, columnar para reportes) y por qué no se eligieron; modelados alternativos
> (detalle de venta embebido o en colección aparte, entre otros).

### 9.3 Conclusiones

> **TODO**
