import type { ClientSession, Collection, Db } from "mongodb";
import neo4j, {
  type Date as FechaNeo4j,
  type Driver,
  type ManagedTransaction,
  type Node,
} from "neo4j-driver";
import { farmaceuticoDesdeNodo } from "../farmaceuticos/repository.js";
import type { Farmaceutico } from "../farmaceuticos/types.js";
import type { Producto } from "../productos/types.js";
import { fijarContador, formatearId, siguienteNumero } from "../lib/contadores.js";
import { OperacionRechazada } from "../lib/errores.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { ItemVenta, Venta } from "./types.js";

/** Prefijos de los ids (V001, D001) y nombres de sus contadores en la colección `contadores`. */
const PREFIJO_VENTA = "V";
const CONTADOR_VENTAS = "ventas";
const PREFIJO_DETALLE = "D";
const CONTADOR_DETALLE = "detalle_ventas";

// MongoDB es la fuente de verdad de las ventas: cada documento guarda la cabecera y sus ítems
// embebidos. Neo4j guarda una copia de cada venta para recorrer sus relaciones: la cabecera es el
// nodo (:Venta), y las referencias y los ítems son relaciones. `id_farmaceutico`, `id_cliente` e
// `id_receta` son (:Venta)-[:ATENDIDA_POR]->(:Farmaceutico), (:Venta)-[:DE_CLIENTE]->(:Cliente) y
// (:Venta)-[:CON_RECETA]->(:Receta); cada ítem es una relación
// (:Venta)-[:INCLUYE {id_detalle, cantidad, precio_unit}]->(:Producto). `stock_descontado` solo
// está en MongoDB.

/**
 * Acceso a ventas. Motores: MongoDB (colección `ventas`, fuente de verdad) y Neo4j (copia como
 * nodos `(:Venta)` con sus relaciones).
 */
export class VentasRepository {
  private readonly coleccion: Collection<Venta>;

  constructor(
    private readonly db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Venta>("ventas");
  }

  /**
   * Reemplaza todas las ventas (carga idempotente) y asegura los índices que usan las consultas:
   * `{estado, fecha}` para las agregaciones que filtran por estado y período, y `{tipo, total}` para
   * `noAnuladasDeTipoConTotalMenorA`. Deja los contadores de ids de ventas y de ítems en los más
   * altos cargados. Escribe primero en MongoDB, que es la fuente de verdad, y después en la copia de
   * Neo4j. Los clientes, las recetas y los productos tienen que estar copiados antes. Si la copia
   * falla, se reconstruye con `npm run sync`.
   */
  async reemplazarTodas(ventas: Venta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (ventas.length > 0) await this.coleccion.insertMany(ventas);
    await this.coleccion.createIndex({ estado: 1, fecha: 1 });
    await this.coleccion.createIndex({ tipo: 1, total: 1 });
    await fijarContador(this.db, CONTADOR_VENTAS, PREFIJO_VENTA, ventas.map((venta) => venta._id));
    await fijarContador(
      this.db,
      CONTADOR_DETALLE,
      PREFIJO_DETALLE,
      ventas.flatMap((venta) => venta.items.map((item) => item.id_detalle)),
    );
    await this.copiarAlGrafo(ventas);
  }

  /**
   * Inserta una venta nueva dentro de la transacción de `session` y la devuelve. Le asigna el
   * próximo id de venta (V021, ...) y uno de ítem a cada ítem (D028, ...). Los contadores avanzan
   * fuera de la transacción: si la transacción se aborta, esos números quedan sin usar. La copia en
   * Neo4j no se escribe acá: se escribe con `copiar` después de confirmar la transacción.
   */
  async registrar(
    datos: Omit<Venta, "_id" | "items"> & { items: Omit<ItemVenta, "id_detalle">[] },
    session: ClientSession,
  ): Promise<Venta> {
    const idVenta = formatearId(PREFIJO_VENTA, await siguienteNumero(this.db, CONTADOR_VENTAS));
    const items: ItemVenta[] = [];
    for (const item of datos.items) {
      const numero = await siguienteNumero(this.db, CONTADOR_DETALLE);
      items.push({ id_detalle: formatearId(PREFIJO_DETALLE, numero), ...item });
    }
    const venta: Venta = { _id: idVenta, ...datos, items };
    await this.coleccion.insertOne(venta, { session });
    return venta;
  }

  /**
   * Escribe la copia de una venta en Neo4j: el nodo (:Venta) con sus relaciones ATENDIDA_POR,
   * DE_CLIENTE, CON_RECETA (si tiene receta) e INCLUYE (una por ítem). Se llama después de confirmar
   * la escritura en MongoDB: si falla, MongoDB ya quedó escrito y la copia se reconstruye con
   * `npm run sync`.
   */
  async copiar(venta: Venta): Promise<void> {
    try {
      await enTransaccion(this.neo4j, (tx) => fusionarEnGrafo(tx, [venta]));
    } catch (error) {
      throw new Error(
        `La venta ${venta._id} quedó guardada en MongoDB, pero no se pudo actualizar su copia ` +
          "en Neo4j. Ejecutá `npm run sync` para reconstruirla desde MongoDB.",
        { cause: error },
      );
    }
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántas copió. */
  async reconstruirCopia(): Promise<number> {
    const ventas = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(ventas);
    return ventas.length;
  }

  /**
   * La venta con ese id, con sus ítems. `null` si no existe. Con `session`, la lee dentro de esa
   * transacción, así que ve también una venta insertada en ella y todavía no confirmada.
   */
  async buscarPorId(idVenta: string, session?: ClientSession): Promise<Venta | null> {
    return this.coleccion.findOne({ _id: idVenta }, { session });
  }

  /**
   * Marca que ya se descontó el stock de la venta, dentro de la transacción de `session`. El filtro
   * exige que todavía no estuviera marcada: si otra operación descontó el stock de la misma venta
   * en el medio, no hay coincidencia y la operación se rechaza.
   */
  async marcarStockDescontado(idVenta: string, session: ClientSession): Promise<void> {
    const { matchedCount } = await this.coleccion.updateOne(
      { _id: idVenta, stock_descontado: false },
      { $set: { stock_descontado: true } },
      { session },
    );
    if (matchedCount === 0) {
      throw new OperacionRechazada(`el stock de la venta ${idVenta} ya se descontó`);
    }
  }

  /**
   * Ventas no anuladas del tipo dado con total menor a `maximo`, con sus ítems, de la más antigua a
   * la más reciente. Filtra con el índice `{tipo, total}`.
   */
  async noAnuladasDeTipoConTotalMenorA(tipo: Venta["tipo"], maximo: number): Promise<Venta[]> {
    return this.coleccion
      .find({ tipo, total: { $lt: maximo }, estado: { $ne: "Anulada" } })
      .sort({ fecha: 1, _id: 1 })
      .toArray();
  }

  /**
   * Ingresos de las ventas 'Completada' con fecha en [`desde`, `hasta`), agrupados por farmacéutico:
   * la suma de los totales y la cantidad de ventas. Un único pipeline que filtra con el índice
   * `{estado, fecha}`. Solo trae los ids: los farmacéuticos están en Neo4j. Ordena por ingresos (mayor
   * primero) y por id.
   */
  async ingresosPorFarmaceutico(
    desde: Date,
    hasta: Date,
  ): Promise<{ id_farmaceutico: string; ingresos: number; cantidad_ventas: number }[]> {
    return this.coleccion
      .aggregate<{ id_farmaceutico: string; ingresos: number; cantidad_ventas: number }>([
        { $match: { estado: "Completada", fecha: { $gte: desde, $lt: hasta } } },
        {
          $group: {
            _id: "$id_farmaceutico",
            ingresos: { $sum: "$total" },
            cantidad_ventas: { $sum: 1 },
          },
        },
        { $sort: { ingresos: -1, _id: 1 } },
        { $project: { _id: 0, id_farmaceutico: "$_id", ingresos: 1, cantidad_ventas: 1 } },
      ])
      .toArray();
  }

  /**
   * Los `limite` productos con más unidades vendidas en ventas 'Completada', con los datos de cada
   * producto. Un único pipeline: filtra por estado (índice `{estado, fecha}`), desarma los ítems
   * embebidos con `$unwind`, suma las cantidades por producto y trae el producto con `$lookup` sobre
   * `productos`. A igual cantidad de unidades, ordena por id de producto.
   */
  async productosMasVendidos(limite: number): Promise<{ producto: Producto; unidades: number }[]> {
    return this.coleccion
      .aggregate<{ producto: Producto; unidades: number }>([
        { $match: { estado: "Completada" } },
        { $unwind: "$items" },
        { $group: { _id: "$items.id_producto", unidades: { $sum: "$items.cantidad" } } },
        { $sort: { unidades: -1, _id: 1 } },
        { $limit: limite },
        { $lookup: { from: "productos", localField: "_id", foreignField: "_id", as: "producto" } },
        { $unwind: "$producto" },
        { $project: { _id: 0, producto: 1, unidades: 1 } },
      ])
      .toArray();
  }

  /**
   * Cabeceras de las ventas en ese estado, con el farmacéutico que las atendió y la sucursal donde
   * trabaja, ordenadas por id. Un único patrón en Neo4j, que filtra con el índice sobre
   * `Venta.estado`.
   */
  async conFarmaceuticoEnEstado(estado: Venta["estado"]): Promise<
    {
      venta: Omit<Venta, "id_cliente" | "id_receta" | "items" | "stock_descontado">;
      farmaceutico: Farmaceutico;
      sucursal: Sucursal;
    }[]
  > {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (v:Venta {estado: $estado})-[:ATENDIDA_POR]->(f:Farmaceutico)-[:TRABAJA_EN]->(s:Sucursal)
       RETURN v, f, s
       ORDER BY v.id_venta`,
      { estado },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const sucursal = sucursalDesdeNodo(registro.get("s"));
      const farmaceutico = farmaceuticoDesdeNodo(registro.get("f"), sucursal.id_sucursal);
      const venta = cabeceraDesdeNodo(registro.get("v"), farmaceutico.id_farmaceutico);
      return { venta, farmaceutico, sucursal };
    });
  }

  /**
   * Deja en el grafo exactamente estas ventas, cada una con sus relaciones, en una única
   * transacción. Si alguna referencia (farmacéutico, cliente, receta o producto de un ítem) no
   * existe, la transacción se aborta: ninguna venta queda sin sus relaciones. Los clientes, las
   * recetas y los productos tienen que estar copiados antes.
   */
  private async copiarAlGrafo(ventas: Venta[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Venta", "id_venta");
    await this.neo4j.executeQuery(
      "CREATE INDEX venta_estado IF NOT EXISTS FOR (v:Venta) ON (v.estado)",
    );
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (v:Venta) WHERE NOT v.id_venta IN $ids DETACH DELETE v", {
        ids: ventas.map((venta) => venta._id),
      });
      await fusionarEnGrafo(tx, ventas);
    });
  }
}

/**
 * Convierte un nodo (:Venta) y lo que la consulta recorrió desde él (farmacéutico, cliente, receta e
 * ítems) en la venta completa, sin `stock_descontado`, que solo está en MongoDB.
 */
export function ventaDesdeNodo(
  nodo: Node,
  relaciones: {
    idCliente: string;
    idFarmaceutico: string;
    idReceta: string | null;
    items: ItemVenta[];
  },
): Omit<Venta, "stock_descontado"> {
  const { _id, ...cabecera } = cabeceraDesdeNodo(nodo, relaciones.idFarmaceutico);
  return {
    _id,
    id_cliente: relaciones.idCliente,
    id_farmaceutico: cabecera.id_farmaceutico,
    id_receta: relaciones.idReceta,
    fecha: cabecera.fecha,
    tipo: cabecera.tipo,
    medio_pago: cabecera.medio_pago,
    total: cabecera.total,
    estado: cabecera.estado,
    items: relaciones.items,
  };
}

/**
 * Crea o actualiza en el grafo estas ventas (MERGE), cada una unida a su farmacéutico, a su cliente,
 * a su receta (si tiene) y a los productos de sus ítems. Antes borra las relaciones que tenía, así
 * que la copia queda igual a la venta recibida. Si alguna referencia no existe, lanza un error y la
 * transacción `tx` se aborta: ninguna venta queda sin sus relaciones.
 */
async function fusionarEnGrafo(tx: ManagedTransaction, ventas: Venta[]): Promise<void> {
  const { records } = await tx.run(
    `UNWIND $ventas AS fila
     MERGE (v:Venta {id_venta: fila.nodo.id_venta})
     SET v = fila.nodo
     WITH v, fila
     CALL (v) {
       MATCH (v)-[anterior:ATENDIDA_POR|DE_CLIENTE|CON_RECETA|INCLUYE]->()
       DELETE anterior
     }
     MATCH (f:Farmaceutico {id_farmaceutico: fila.id_farmaceutico})
     MATCH (c:Cliente {id_cliente: fila.id_cliente})
     CREATE (v)-[:ATENDIDA_POR]->(f), (v)-[:DE_CLIENTE]->(c)
     WITH v, fila
     OPTIONAL MATCH (r:Receta {id_receta: fila.id_receta})
     FOREACH (receta IN CASE WHEN r IS NULL THEN [] ELSE [r] END |
       CREATE (v)-[:CON_RECETA]->(receta))
     WITH v, fila, r
     CALL (v, fila) {
       UNWIND fila.items AS item
       MATCH (p:Producto {id_producto: item.id_producto})
       CREATE (v)-[:INCLUYE {
         id_detalle: item.id_detalle, cantidad: item.cantidad, precio_unit: item.precio_unit
       }]->(p)
       RETURN count(*) AS items
     }
     RETURN sum(CASE WHEN items = size(fila.items) AND (r IS NULL) = (fila.id_receta IS NULL)
                     THEN 1 ELSE 0 END) AS completas`,
    {
      ventas: ventas.map((venta) => ({
        nodo: aNodo(venta),
        id_farmaceutico: venta.id_farmaceutico,
        id_cliente: venta.id_cliente,
        id_receta: venta.id_receta,
        items: venta.items.map((item) => ({
          id_detalle: item.id_detalle,
          id_producto: item.id_producto,
          cantidad: neo4j.int(item.cantidad),
          precio_unit: neo4j.int(item.precio_unit),
        })),
      })),
    },
  );
  const completas: number = records[0].get("completas");
  if (completas !== ventas.length) {
    throw new Error(
      `Neo4j: solo ${completas} de ${ventas.length} ventas encontraron su farmacéutico, su cliente, ` +
        "su receta y los productos de sus ítems",
    );
  }
}

/**
 * Propiedades del nodo (:Venta). `total` se envía explícitamente como entero de Neo4j, y la fecha
 * como `date` de Neo4j, tomando el día en UTC (así lo construye la carga).
 */
function aNodo(venta: Venta) {
  return {
    id_venta: venta._id,
    fecha: neo4j.types.Date.fromStandardDateUTC(venta.fecha),
    tipo: venta.tipo,
    medio_pago: venta.medio_pago,
    total: neo4j.int(venta.total),
    estado: venta.estado,
  };
}

/**
 * Convierte un nodo (:Venta) en la cabecera de la venta. `idFarmaceutico` sale de la relación
 * ATENDIDA_POR, que la consulta recorre. El `date` de Neo4j vuelve como medianoche UTC.
 */
function cabeceraDesdeNodo(
  nodo: Node,
  idFarmaceutico: string,
): Omit<Venta, "id_cliente" | "id_receta" | "items" | "stock_descontado"> {
  const v = nodo.properties;
  return {
    _id: v.id_venta,
    id_farmaceutico: idFarmaceutico,
    fecha: (v.fecha as FechaNeo4j<number>).toStandardDate(),
    tipo: v.tipo,
    medio_pago: v.medio_pago,
    total: v.total,
    estado: v.estado,
  };
}
