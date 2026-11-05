import type { Collection, Db } from "mongodb";
import type { Producto } from "./types.js";

/** Acceso a productos. Motor: MongoDB, colección `productos`. */
export class ProductosRepository {
  private readonly coleccion: Collection<Producto>;

  constructor(db: Db) {
    this.coleccion = db.collection<Producto>("productos");
  }

  /** Reemplaza todo el catálogo (carga idempotente). */
  async reemplazarTodos(productos: Producto[]): Promise<void> {
    await this.coleccion.deleteMany({});
    if (productos.length > 0) await this.coleccion.insertMany(productos);
  }

  /** Productos con `activo: true`, ordenados por id. */
  async activos(): Promise<Producto[]> {
    return this.coleccion.find({ activo: true }).sort({ _id: 1 }).toArray();
  }
}
