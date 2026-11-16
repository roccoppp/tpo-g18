import type { ClientSession, Collection, Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type Node } from "neo4j-driver";
import { OperacionRechazada } from "../lib/errores.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { productoDesdeNodo } from "../productos/repository.js";
import type { Producto } from "../productos/types.js";
import { proveedorDesdeNodo } from "../proveedores/repository.js";
import type { Proveedor } from "../proveedores/types.js";
import { sucursalDesdeNodo } from "../sucursales/repository.js";
import type { Sucursal } from "../sucursales/types.js";
import type { Lote } from "./types.js";

// MongoDB es la fuente de verdad del stock: ahí ocurren los descuentos de q15, dentro de una
// transacción. Neo4j guarda una copia de cada lote como nodo (:Lote) para recorrer sus relaciones.
// En el grafo, `id_producto` e `id_sucursal` no son propiedades: son las relaciones
// (:Lote)-[:DE_PRODUCTO]->(:Producto) y (:Lote)-[:EN_SUCURSAL]->(:Sucursal).

/**
 * Acceso a lotes de stock. Motores: MongoDB (colección `lotes`, fuente de verdad) y Neo4j (copia
 * como nodos `(:Lote)`).
*/
export class LotesRepository {
  private readonly coleccion: Collection<Lote>;

  constructor(
    db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Lote>("lotes");
  }

  /**
   * Reemplaza todos los lotes (carga idempotente). Escribe primero en MongoDB, que es la fuente de
   * verdad, y después en la copia de Neo4j. Si la copia falla, se reconstruye con `npm run sync`.
  */
  async reemplazarTodos(lotes: Lote[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (lotes.length > 0) await this.coleccion.insertMany(lotes);
    await this.coleccion.createIndex({ id_sucursal: 1, id_producto: 1, vencimiento: 1 });
    await this.copiarAlGrafo(lotes);
  }

  /**
   * Descuenta de los lotes de la sucursal las unidades de cada ítem con criterio FEFO (primero el
   * lote que vence antes), dentro de la transacción de `session`. Solo usa lotes con unidades y no
   * vencidos: un lote que vence hoy todavía se puede dispensar. Calcula el descuento completo antes
   * de escribir: si para algún producto el stock vigente no alcanza, rechaza la operación sin
   * modificar ningún lote.
   *
   * Cada `update` filtra además por `unidades >= lo que descuenta`, así que el stock nunca queda
   * negativo: si otra venta descontó del mismo lote en el medio, no hay coincidencia y la operación
   * se rechaza (y la transacción se descarta). La copia de Neo4j no se actualiza acá: se actualiza
   * con `copiarUnidades` después de confirmar la transacción.
   *
   * @returns cada lote modificado, antes y después del descuento, en el orden en que se consumió.
   */
  async descontarFefo(
    idSucursal: string,
    items: { id_producto: string; cantidad: number }[],
    hoy: Date,
    session: ClientSession,
  ): Promise<{ antes: Lote; despues: Lote }[]> {
    const vigentes = await this.coleccion
      .find(
        {
          id_sucursal: idSucursal,
          id_producto: { $in: items.map((item) => item.id_producto) },
          vencimiento: { $gte: hoy },
          unidades: { $gt: 0 },
        },
        { session },
      )
      .sort({ vencimiento: 1, _id: 1 })
      .toArray();
    const descuentos = planDeDescuento(vigentes, items, idSucursal);
    for (const { lote, unidades } of descuentos) {
      const { matchedCount } = await this.coleccion.updateOne(
        { _id: lote._id, unidades: { $gte: unidades } },
        { $inc: { unidades: -unidades } },
        { session },
      );
      if (matchedCount === 0) {
        throw new OperacionRechazada(
          `el lote ${lote._id} cambió mientras se descontaba el stock; volvé a intentarlo`,
        );
      }
    }
    return descuentos.map(({ lote, unidades }) => ({
      antes: lote,
      despues: { ...lote, unidades: lote.unidades - unidades },
    }));
  }

  /**
   * Actualiza las unidades de estos lotes en la copia de Neo4j, en una única transacción. Se llama
   * después de confirmar el descuento en MongoDB: si falla, MongoDB ya quedó escrito y la copia se
   * reconstruye con `npm run sync`.
   *
   * Las unidades de un lote solo bajan (el único servicio que las modifica es el descuento de q15),
   * así que el nodo se queda con el menor valor entre el que tiene y el recibido. Si dos ventas
   * descuentan del mismo lote y sus copias llegan en el orden inverso al de sus confirmaciones, la
   * copia igual termina en el valor de MongoDB; y repetir una copia no cambia el resultado.
   */
  async copiarUnidades(lotes: Lote[]): Promise<void> {
    try {
      await enTransaccion(this.neo4j, async (tx) => {
        const { records } = await tx.run(
          `UNWIND $lotes AS fila
           MATCH (l:Lote {id_lote: fila.id_lote})
           SET l.unidades = CASE WHEN fila.unidades < l.unidades THEN fila.unidades ELSE l.unidades END
           RETURN count(l) AS actualizados`,
          { lotes: lotes.map((lote) => ({ id_lote: lote._id, unidades: neo4j.int(lote.unidades) })) },
        );
        const actualizados: number = records[0].get("actualizados");
        if (actualizados !== lotes.length) {
          throw new Error(`Neo4j: solo se encontraron ${actualizados} de ${lotes.length} lotes`);
        }
      });
    } catch (error) {
      throw new Error(
        `El stock de los lotes ${lotes.map((lote) => lote._id).join(", ")} quedó descontado en ` +
          "MongoDB, pero no se pudo actualizar su copia en Neo4j. Ejecutá `npm run sync` para " +
          "reconstruirla desde MongoDB.",
        { cause: error },
      );
    }
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántos copió. */
  async reconstruirCopia(): Promise<number> {
    const lotes = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(lotes);
    return lotes.length;
  }

  /**
   * Lotes con menos de `limite` unidades, con su producto, su sucursal y el proveedor del producto,
   * ordenados por id. Un único patrón en Neo4j, que filtra con el índice sobre `Lote.unidades`.
   */
  async conMenosUnidadesQue(
    limite: number,
  ): Promise<{ lote: Lote; producto: Producto; sucursal: Sucursal; proveedor: Proveedor }[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (l:Lote)-[:DE_PRODUCTO]->(p:Producto)-[:PROVISTO_POR]->(pr:Proveedor),
             (l)-[:EN_SUCURSAL]->(s:Sucursal)
       WHERE l.unidades < $limite
       RETURN l, p, s, pr
       ORDER BY l.id_lote`,
      { limite: neo4j.int(limite) },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const proveedor = proveedorDesdeNodo(registro.get("pr"));
      const producto = productoDesdeNodo(registro.get("p"), proveedor.id_proveedor);
      const sucursal = sucursalDesdeNodo(registro.get("s"));
      const lote = loteDesdeNodo(registro.get("l"), producto._id, sucursal.id_sucursal);
      return { lote, producto, sucursal, proveedor };
    });
  }

  /**
   * Deja en el grafo exactamente estos lotes, cada uno unido a su producto y a su sucursal, en una
   * única transacción. Si algún producto o sucursal no existe, la transacción se aborta: ningún
   * lote queda sin sus relaciones.
   */
  private async copiarAlGrafo(lotes: Lote[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Lote", "id_lote");
    await this.neo4j.executeQuery(
      "CREATE INDEX lote_unidades IF NOT EXISTS FOR (l:Lote) ON (l.unidades)",
    );
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (l:Lote) WHERE NOT l.id_lote IN $ids DETACH DELETE l", {
        ids: lotes.map((lote) => lote._id),
      });
      const { records } = await tx.run(
        `UNWIND $lotes AS fila
         MERGE (l:Lote {id_lote: fila.nodo.id_lote})
         SET l = fila.nodo
         WITH l, fila
         OPTIONAL MATCH (l)-[anterior:DE_PRODUCTO|EN_SUCURSAL]->()
         DELETE anterior
         WITH DISTINCT l, fila.id_producto AS idProducto, fila.id_sucursal AS idSucursal
         MATCH (p:Producto {id_producto: idProducto}), (s:Sucursal {id_sucursal: idSucursal})
         CREATE (l)-[:DE_PRODUCTO]->(p), (l)-[:EN_SUCURSAL]->(s)
         RETURN count(*) AS relacionados`,
        {
          lotes: lotes.map((lote) => ({
            nodo: aNodo(lote),
            id_producto: lote.id_producto,
            id_sucursal: lote.id_sucursal,
          })),
        },
      );
      const relacionados: number = records[0].get("relacionados");
      if (relacionados !== lotes.length) {
        throw new Error(
          `Neo4j: solo ${relacionados} de ${lotes.length} lotes encontraron su producto y su sucursal`,
        );
      }
    });
  }
}

/**
 * Propiedades del nodo (:Lote). `unidades` se envía explícitamente como entero de Neo4j, y el
 * vencimiento como `date` de Neo4j, tomando el día en UTC (así lo construye la carga).
 */
function aNodo(lote: Lote) {
  return {
    id_lote: lote._id,
    nro_lote: lote.nro_lote,
    unidades: neo4j.int(lote.unidades),
    vencimiento: neo4j.types.Date.fromStandardDateUTC(lote.vencimiento),
  };
}

/**
 * Convierte un nodo (:Lote) al tipo del dominio. `idProducto` e `idSucursal` salen de las
 * relaciones que la consulta recorre. El `date` de Neo4j vuelve como medianoche UTC.
 */
function loteDesdeNodo(nodo: Node, idProducto: string, idSucursal: string): Lote {
  const l = nodo.properties;
  return {
    _id: l.id_lote,
    id_producto: idProducto,
    id_sucursal: idSucursal,
    nro_lote: l.nro_lote,
    unidades: l.unidades,
    vencimiento: (l.vencimiento as FechaNeo4j<number>).toStandardDate(),
  };
}

/**
 * Reparte la cantidad pedida de cada producto entre sus lotes vigentes, en el orden recibido (el
 * de vencimiento). Si un producto aparece en varios ítems, suma sus cantidades. Si el stock
 * vigente de algún producto no alcanza, rechaza la operación.
 */
function planDeDescuento(
  vigentes: Lote[],
  items: { id_producto: string; cantidad: number }[],
  idSucursal: string,
): { lote: Lote; unidades: number }[] {
  const pedidos = new Map<string, number>();
  for (const { id_producto, cantidad } of items) {
    pedidos.set(id_producto, (pedidos.get(id_producto) ?? 0) + cantidad);
  }
  const plan: { lote: Lote; unidades: number }[] = [];
  for (const [idProducto, cantidad] of pedidos) {
    const lotes = vigentes.filter((lote) => lote.id_producto === idProducto);
    const disponible = lotes.reduce((suma, lote) => suma + lote.unidades, 0);
    if (disponible < cantidad) {
      const pedido = cantidad === 1 ? "se pide 1 unidad" : `se piden ${cantidad} unidades`;
      throw new OperacionRechazada(
        `stock vigente insuficiente de ${idProducto} en ${idSucursal}: ${pedido} y hay ${disponible}`,
      );
    }
    let restante = cantidad;
    for (const lote of lotes) {
      if (restante === 0) break;
      const unidades = Math.min(restante, lote.unidades);
      plan.push({ lote, unidades });
      restante -= unidades;
    }
  }
  return plan;
}
