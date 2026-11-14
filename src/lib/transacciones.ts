import type { ClientSession, Db } from "mongodb";

/**
 * Transacciones multi-documento de MongoDB para los servicios de escritura (q14 y q15). Las
 * consultas no reciben `Db`: reciben esta clase, y cada repositorio recibe la `session` en las
 * operaciones que forman parte de la transacción.
 */
export class TransaccionesMongo {
  constructor(private readonly db: Db) {}

  /**
   * Ejecuta `trabajo` en una transacción: si termina sin error se confirma todo, y si lanza
   * cualquier error (por ejemplo, una OperacionRechazada) se descarta todo. El driver reintenta
   * el trabajo completo ante errores transitorios, como un conflicto de escritura con otra
   * transacción.
   */
  async ejecutar<T>(trabajo: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.db.client.startSession();
    try {
      return await session.withTransaction(() => trabajo(session));
    } finally {
      await session.endSession();
    }
  }
}
