import type { ClientSession, Collection, Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type ManagedTransaction, type Node } from "neo4j-driver";
import type { Cliente } from "../clientes/types.js";
import { OperacionRechazada } from "../lib/errores.js";
import { sumarDias } from "../lib/fechas.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import type { Receta } from "./types.js";

/** Días entre dispensas de una receta de tratamiento prolongado (enunciado §2.11). */
const DIAS_ENTRE_DISPENSAS = 30;

// MongoDB es la fuente de verdad de las recetas: las valida y las dispensa q14, dentro de su
// transacción. Neo4j guarda una copia de cada receta como nodo (:Receta), para recorrer la red
// cliente–receta–venta–producto (q03). En el grafo, `id_cliente` no es una propiedad: es la relación
// (:Receta)-[:EMITIDA_PARA]->(:Cliente). Las ventas la referencian con
// (:Venta)-[:CON_RECETA]->(:Receta).

/**
 * Acceso a recetas. Motores: MongoDB (colección `recetas`, fuente de verdad) y Neo4j (copia como
 * nodos `(:Receta)`).
 */
export class RecetasRepository {
  private readonly coleccion: Collection<Receta>;

  constructor(
    db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Receta>("recetas");
  }

  /**
   * Reemplaza todas las recetas (carga idempotente) y asegura el índice que usa
   * `vigentesConDispensaAntesDe`. Escribe primero en MongoDB, que es la fuente de verdad, y después
   * en la copia de Neo4j. Los clientes tienen que estar copiados antes. Si la copia falla, se
   * reconstruye con `npm run sync`.
   */
  async reemplazarTodas(recetas: Receta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (recetas.length > 0) await this.coleccion.insertMany(recetas);
    await this.coleccion.createIndex({ tipo: 1, estado: 1, proxima_dispensa: 1 });
    await this.copiarAlGrafo(recetas);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántas copió. */
  async reconstruirCopia(): Promise<number> {
    const recetas = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(recetas);
    return recetas.length;
  }

  /**
   * Escribe la copia de una receta en Neo4j. Se llama después de confirmar la escritura en MongoDB
   * (la dispensa de q14): si falla, MongoDB ya quedó escrito y la copia se reconstruye con
   * `npm run sync`.
   *
   * Las dispensas de una receta solo aumentan, así que la copia no se pisa con una versión con menos
   * dispensas: si dos ventas dispensan la misma receta y sus copias llegan en otro orden, el nodo
   * queda igual con la más reciente.
   */
  async copiar(receta: Receta): Promise<void> {
    try {
      await enTransaccion(this.neo4j, (tx) => fusionarEnGrafo(tx, [receta], { forzar: false }));
    } catch (error) {
      throw new Error(
        `La receta ${receta._id} quedó guardada en MongoDB, pero no se pudo actualizar su copia ` +
          "en Neo4j. Ejecutá `npm run sync` para reconstruirla desde MongoDB.",
        { cause: error },
      );
    }
  }

  /** La receta con ese id, en cualquier estado. `null` si no existe. */
  async buscarPorId(idReceta: string): Promise<Receta | null> {
    return this.coleccion.findOne({ _id: idReceta });
  }

  /**
   * Registra una dispensa de la receta en `fecha`, dentro de la transacción de `session`, y devuelve
   * la receta actualizada. Reglas de negocio (§2.11): suma una dispensa; si quedan dispensas
   * autorizadas, la próxima se fija 30 días después; si no, la receta pasa a 'Completada' y la
   * próxima dispensa queda vacía. Las recetas simples y archivadas se completan con su única
   * dispensa. Quien llama ya validó que la receta está 'Vigente'.
   *
   * El filtro incluye el estado y las dispensas leídas: si otra venta dispensó la misma receta
   * entre la lectura y esta escritura, no hay coincidencia y la operación se rechaza.
   */
  async dispensar(receta: Receta, fecha: Date, session: ClientSession): Promise<Receta> {
    const dispensasRealizadas = receta.dispensas_realizadas + 1;
    const completa =
      receta.tipo !== "Tratamiento prolongado" || dispensasRealizadas >= receta.dispensas_autorizadas;
    const cambios = {
      dispensas_realizadas: dispensasRealizadas,
      proxima_dispensa: completa ? null : sumarDias(fecha, DIAS_ENTRE_DISPENSAS),
      estado: completa ? ("Completada" as const) : ("Vigente" as const),
    };
    const { matchedCount } = await this.coleccion.updateOne(
      { _id: receta._id, estado: "Vigente", dispensas_realizadas: receta.dispensas_realizadas },
      { $set: cambios },
      { session },
    );
    if (matchedCount === 0) {
      throw new OperacionRechazada(`la receta ${receta._id} cambió mientras se registraba la venta`);
    }
    return { ...receta, ...cambios };
  }

  /**
   * Recetas del tipo dado, en estado 'Vigente', cuya próxima dispensa es anterior a `fecha`, con los
   * datos de su cliente. Un único pipeline: filtra con el índice sobre tipo, estado y próxima
   * dispensa, y trae el cliente con `$lookup` sobre `clientes`. Ordena por próxima dispensa (la más
   * atrasada primero) y por id.
   */
  async vigentesConDispensaAntesDe(
    tipo: Receta["tipo"],
    fecha: Date,
  ): Promise<{ receta: Receta; cliente: Cliente }[]> {
    const filas = await this.coleccion
      .aggregate<Receta & { cliente: Cliente }>([
        { $match: { tipo, estado: "Vigente", proxima_dispensa: { $lt: fecha } } },
        { $sort: { proxima_dispensa: 1, _id: 1 } },
        { $lookup: { from: "clientes", localField: "id_cliente", foreignField: "_id", as: "cliente" } },
        { $unwind: "$cliente" },
      ])
      .toArray();
    return filas.map(({ cliente, ...receta }) => ({ receta, cliente }));
  }

  /**
   * Clientes con más de `minimo` recetas registradas (en cualquier estado), con la cantidad. Un
   * único pipeline de agregación: agrupa las recetas por cliente, filtra por la cantidad y trae los
   * datos de cada cliente con `$lookup` sobre `clientes`. Ordena por cantidad (mayor primero) y,
   * a igual cantidad, por id de cliente.
   */
  async clientesConMasRecetasQue(minimo: number): Promise<{ cliente: Cliente; cantidad: number }[]> {
    return this.coleccion
      .aggregate<{ cliente: Cliente; cantidad: number }>([
        { $group: { _id: "$id_cliente", cantidad: { $sum: 1 } } },
        { $match: { cantidad: { $gt: minimo } } },
        { $lookup: { from: "clientes", localField: "_id", foreignField: "_id", as: "cliente" } },
        { $unwind: "$cliente" },
        { $sort: { cantidad: -1, _id: 1 } },
        { $project: { _id: 0, cliente: 1, cantidad: 1 } },
      ])
      .toArray();
  }

  /**
   * Deja en el grafo exactamente estas recetas, cada una unida a su cliente, en una única
   * transacción. Si algún cliente no existe, la transacción se aborta: ninguna receta queda sin su
   * relación. Una receta que se borra pierde también la relación CON_RECETA de sus ventas, que
   * vuelve con la copia de las ventas (la carga y `npm run sync` las copian después).
   */
  private async copiarAlGrafo(recetas: Receta[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Receta", "id_receta");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (r:Receta) WHERE NOT r.id_receta IN $ids DETACH DELETE r", {
        ids: recetas.map((receta) => receta._id),
      });
      // La carga y `npm run sync` copian el estado completo de MongoDB: reemplazan cada nodo aunque
      // tenga más dispensas.
      await fusionarEnGrafo(tx, recetas, { forzar: true });
    });
  }
}

/**
 * Convierte un nodo (:Receta) al tipo del dominio. `idCliente` sale de la relación EMITIDA_PARA que
 * la consulta recorre. Los `date` de Neo4j vuelven como medianoche UTC, y una próxima dispensa
 * ausente vuelve como null.
 */
export function recetaDesdeNodo(nodo: Node, idCliente: string): Receta {
  const r = nodo.properties;
  const proxima = r.proxima_dispensa as FechaNeo4j<number> | undefined;
  return {
    _id: r.id_receta,
    id_cliente: idCliente,
    medico: r.medico,
    matricula_medico: r.matricula_medico,
    fecha_emision: (r.fecha_emision as FechaNeo4j<number>).toStandardDate(),
    tipo: r.tipo,
    dispensas_autorizadas: r.dispensas_autorizadas,
    dispensas_realizadas: r.dispensas_realizadas,
    proxima_dispensa: proxima === undefined ? null : proxima.toStandardDate(),
    estado: r.estado,
  };
}

/**
 * Crea o actualiza en el grafo estas recetas (MERGE), cada una unida a su cliente con EMITIDA_PARA.
 * Sin `forzar`, un nodo que ya tiene más dispensas que la receta recibida no se modifica (ver
 * `copiar`). Si algún cliente no existe, lanza un error y la transacción `tx` se aborta: ninguna
 * receta queda sin su relación.
 */
async function fusionarEnGrafo(
  tx: ManagedTransaction,
  recetas: Receta[],
  { forzar }: { forzar: boolean },
): Promise<void> {
  const { records } = await tx.run(
    `UNWIND $recetas AS fila
     MATCH (c:Cliente {id_cliente: fila.id_cliente})
     CALL (fila, c) {
       MERGE (r:Receta {id_receta: fila.nodo.id_receta})
       WITH r, c, fila
       WHERE $forzar OR coalesce(r.dispensas_realizadas, -1) <= fila.nodo.dispensas_realizadas
       SET r = fila.nodo
       WITH r, c
       OPTIONAL MATCH (r)-[anterior:EMITIDA_PARA]->()
       DELETE anterior
       WITH DISTINCT r, c
       CREATE (r)-[:EMITIDA_PARA]->(c)
     }
     RETURN count(*) AS conCliente`,
    {
      recetas: recetas.map((receta) => ({ nodo: aNodo(receta), id_cliente: receta.id_cliente })),
      forzar,
    },
  );
  const conCliente: number = records[0].get("conCliente");
  if (conCliente !== recetas.length) {
    throw new Error(`Neo4j: solo ${conCliente} de ${recetas.length} recetas encontraron su cliente`);
  }
}

/**
 * Propiedades del nodo (:Receta). Los enteros se envían explícitamente como enteros de Neo4j, y las
 * fechas como `date` de Neo4j, tomando el día en UTC (así las construye la carga). Neo4j no guarda
 * propiedades nulas: una receta sin próxima dispensa queda sin `proxima_dispensa` en el nodo.
 */
function aNodo(receta: Receta) {
  return {
    id_receta: receta._id,
    medico: receta.medico,
    matricula_medico: receta.matricula_medico,
    fecha_emision: neo4j.types.Date.fromStandardDateUTC(receta.fecha_emision),
    tipo: receta.tipo,
    dispensas_autorizadas: neo4j.int(receta.dispensas_autorizadas),
    dispensas_realizadas: neo4j.int(receta.dispensas_realizadas),
    proxima_dispensa:
      receta.proxima_dispensa === null
        ? null
        : neo4j.types.Date.fromStandardDateUTC(receta.proxima_dispensa),
    estado: receta.estado,
  };
}
