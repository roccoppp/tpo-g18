import type { ClientSession, Collection, Db } from "mongodb";
import type { Cliente } from "../clientes/types.js";
import { OperacionRechazada } from "../lib/errores.js";
import { sumarDias } from "../lib/fechas.js";
import type { Receta } from "./types.js";

/** Días entre dispensas de una receta de tratamiento prolongado (enunciado §2.11). */
const DIAS_ENTRE_DISPENSAS = 30;

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
