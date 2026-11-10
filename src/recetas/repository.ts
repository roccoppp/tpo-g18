import type { Collection, Db } from "mongodb";
import type { Cliente } from "../clientes/types.js";
import type { Receta } from "./types.js";

/** Acceso a recetas. Motor: MongoDB, colección `recetas`. */
export class RecetasRepository {
  private readonly coleccion: Collection<Receta>;

  constructor(db: Db) {
    this.coleccion = db.collection<Receta>("recetas");
  }

  /**
   * Reemplaza todas las recetas (carga idempotente) y asegura los índices que usan `deCliente` y
   * `vigentesConDispensaAntesDe`.
   */
  async reemplazarTodas(recetas: Receta[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (recetas.length > 0) await this.coleccion.insertMany(recetas);
    await this.coleccion.createIndex({ id_cliente: 1, fecha_emision: 1 });
    await this.coleccion.createIndex({ tipo: 1, estado: 1, proxima_dispensa: 1 });
  }

  /** Recetas de un cliente, de la más antigua a la más reciente. */
  async deCliente(idCliente: string): Promise<Receta[]> {
    return this.coleccion
      .find({ id_cliente: idCliente })
      .sort({ fecha_emision: 1, _id: 1 })
      .toArray();
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
}
