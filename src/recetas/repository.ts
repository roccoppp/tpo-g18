import type { Collection, Db } from "mongodb";
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
}
