import type { Collection, Db } from "mongodb";
import type { Cliente } from "../clientes/types.js";
import type { Receta } from "./types.js";

/** Acceso a recetas. Motor: MongoDB, colección `recetas`. */
export class RecetasRepository {
  private readonly coleccion: Collection<Receta>;

  constructor(db: Db) {
    this.coleccion = db.collection<Receta>("recetas");
  }

  /** Reemplaza todas las recetas (carga idempotente) y asegura el índice que usa `deCliente`. */
  async reemplazarTodas(recetas: Receta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (recetas.length > 0) await this.coleccion.insertMany(recetas);
    await this.coleccion.createIndex({ id_cliente: 1, fecha_emision: 1 });
  }

  /** Recetas de un cliente, de la más antigua a la más reciente. */
  async deCliente(idCliente: string): Promise<Receta[]> {
    return this.coleccion
      .find({ id_cliente: idCliente })
      .sort({ fecha_emision: 1, _id: 1 })
      .toArray();
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
}
