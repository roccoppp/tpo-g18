import { MongoServerError, type Collection, type Db } from "mongodb";
import neo4j, { type Date as FechaNeo4j, type Driver, type Node } from "neo4j-driver";
import { fijarContador, formatearId, siguienteNumero } from "../lib/contadores.js";
import { OperacionRechazada } from "../lib/errores.js";
import { asegurarIdUnico, enTransaccion } from "../lib/grafo.js";
import { recetaDesdeNodo } from "../recetas/repository.js";
import type { Receta } from "../recetas/types.js";
import { ventaDesdeNodo } from "../ventas/repository.js";
import type { ItemVenta, Venta } from "../ventas/types.js";
import type { Cliente } from "./types.js";

// MongoDB es la fuente de verdad de los clientes: los escribe el ABM (q13) y los valida el registro
// de ventas (q14). Neo4j guarda una copia de cada cliente como nodo (:Cliente), para las consultas
// que recorren sus relaciones. Cada escritura va primero a MongoDB y después a la copia.

/** Prefijo de los ids de cliente (C001) y nombre de su contador en la colección `contadores`. */
const PREFIJO_ID = "C";
const CONTADOR = "clientes";

/**
 * Acceso a clientes. Motores: MongoDB (colección `clientes`, fuente de verdad) y Neo4j (copia como
 * nodos `(:Cliente)`).
 */
export class ClientesRepository {
  private readonly coleccion: Collection<Cliente>;

  constructor(
    private readonly db: Db,
    private readonly neo4j: Driver,
  ) {
    this.coleccion = db.collection<Cliente>("clientes");
  }

  /**
   * Reemplaza todos los clientes (carga idempotente) y crea el índice único sobre `dni`, que es el
   * que garantiza el DNI único en las altas, incluso si llegan dos a la vez. Deja el contador de ids
   * en el más alto cargado. Escribe primero en MongoDB y después en la copia de Neo4j.
   */
  async reemplazarTodos(clientes: Cliente[]): Promise<void> {
    await this.coleccion.deleteMany({});
    await this.coleccion.createIndex({ dni: 1 }, { unique: true, name: "dni_unico" });
    if (clientes.length > 0) await this.coleccion.insertMany(clientes);
    await fijarContador(this.db, CONTADOR, PREFIJO_ID, clientes.map((cliente) => cliente._id));
    await this.copiarAlGrafo(clientes);
  }

  /** Reconstruye la copia de Neo4j a partir de MongoDB (`npm run sync`). Devuelve cuántos copió. */
  async reconstruirCopia(): Promise<number> {
    const clientes = await this.coleccion.find().sort({ _id: 1 }).toArray();
    await this.copiarAlGrafo(clientes);
    return clientes.length;
  }

  async buscarPorId(idCliente: string): Promise<Cliente | null> {
    return this.coleccion.findOne({ _id: idCliente });
  }

  /**
   * Da de alta un cliente activo con el próximo id del contador (C009, C010, ...). Si el DNI ya
   * está registrado, rechaza el alta e indica qué cliente lo tiene.
   */
  async alta(datos: Omit<Cliente, "_id" | "activo">): Promise<Cliente> {
    // Verificación previa: el caso común se rechaza sin consumir un número del contador.
    await this.rechazarSiDniRegistrado(datos.dni);
    const cliente: Cliente = {
      _id: formatearId(PREFIJO_ID, await siguienteNumero(this.db, CONTADOR)),
      nombre: datos.nombre,
      apellido: datos.apellido,
      dni: datos.dni,
      email: datos.email,
      telefono: datos.telefono,
      ciudad: datos.ciudad,
      provincia: datos.provincia,
      obra_social: datos.obra_social,
      nro_afiliado: datos.nro_afiliado || null,
      activo: true,
    };
    try {
      await this.coleccion.insertOne(cliente);
    } catch (error) {
      // Otra alta con el mismo DNI se confirmó entre la verificación y este insert: la frena el
      // índice único, que es la garantía real.
      if (esClaveDuplicada(error, "dni")) await this.rechazarSiDniRegistrado(datos.dni);
      throw error;
    }
    await this.copiar(cliente);
    return cliente;
  }

  /**
   * Aplica `cambios` solo si el cliente sigue exactamente igual que `antes`: el filtro es el
   * documento completo. Si otra escritura lo modificó en el medio, rechaza en lugar de pisarla,
   * porque el servicio validó los cambios contra `antes`. Devuelve el cliente actualizado.
   */
  async actualizar(antes: Cliente, cambios: Partial<Omit<Cliente, "_id">>): Promise<Cliente> {
    const despues = await this.coleccion.findOneAndUpdate(
      antes,
      { $set: cambios },
      { returnDocument: "after" },
    );
    if (!despues) {
      throw new OperacionRechazada(
        `el cliente ${antes._id} cambió mientras se procesaba la operación; volvé a intentarlo`,
      );
    }
    await this.copiar(despues);
    return despues;
  }

  /**
   * Clientes, activos o dados de baja, que tienen alguna venta atendida por un farmacéutico de la
   * sucursal, esté activo o no, ordenados por id. Cuenta las ventas en cualquier estado. Un único
   * patrón en Neo4j que recorre
   *   (:Sucursal)<-[:TRABAJA_EN]-(:Farmaceutico)<-[:ATENDIDA_POR]-(:Venta)-[:DE_CLIENTE]->(:Cliente).
   * El `OPTIONAL MATCH` distingue una sucursal sin clientes (lista vacía) de una que no existe (null).
   */
  async atendidosEnSucursal(idSucursal: string): Promise<Cliente[] | null> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (s:Sucursal {id_sucursal: $idSucursal})
       OPTIONAL MATCH (s)<-[:TRABAJA_EN]-(:Farmaceutico)<-[:ATENDIDA_POR]-(:Venta)-[:DE_CLIENTE]->(c:Cliente)
       WITH s, c
       ORDER BY c.id_cliente
       RETURN s.id_sucursal AS idSucursal, collect(DISTINCT c) AS clientes`,
      { idSucursal },
      { routing: neo4j.routing.READ },
    );
    if (records.length === 0) return null;
    return (records[0].get("clientes") as Node[]).map(clienteDesdeNodo);
  }

  /**
   * Clientes, activos o dados de baja, que no tienen ninguna venta (en cualquier estado) con fecha
   * desde `desde` en adelante, con la fecha de su última venta (null si nunca compraron), ordenados
   * por id. Un único patrón en Neo4j: el `NOT EXISTS` sobre la relación DE_CLIENTE descarta a los
   * que compraron en el período.
   */
  async sinVentasDesde(desde: Date): Promise<{ cliente: Cliente; ultimaVenta: Date | null }[]> {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (c:Cliente)
       WHERE NOT EXISTS { (c)<-[:DE_CLIENTE]-(v:Venta) WHERE v.fecha >= $desde }
       OPTIONAL MATCH (c)<-[:DE_CLIENTE]-(anterior:Venta)
       RETURN c, max(anterior.fecha) AS ultimaVenta
       ORDER BY c.id_cliente`,
      { desde: neo4j.types.Date.fromStandardDateUTC(desde) },
      { routing: neo4j.routing.READ },
    );
    return records.map((registro) => {
      const ultimaVenta: FechaNeo4j<number> | null = registro.get("ultimaVenta");
      return {
        cliente: clienteDesdeNodo(registro.get("c")),
        ultimaVenta: ultimaVenta === null ? null : ultimaVenta.toStandardDate(),
      };
    });
  }

  /**
   * Historial de un cliente (q03): sus recetas y sus ventas, de la más antigua a la más reciente. A
   * igual fecha, la receta va antes que la venta, y después ordena por id. `null` si el cliente no
   * existe. Un único patrón en Neo4j: desde el cliente sigue
   *   (:Cliente)<-[:EMITIDA_PARA|DE_CLIENTE]-(:Receta|:Venta)
   * y, desde cada venta, ATENDIDA_POR (el farmacéutico), CON_RECETA (la receta con la que se
   * dispensó) e INCLUYE (los productos, con cantidad y precio). El grafo devuelve el historial ya
   * ordenado.
   */
  async historial(idCliente: string): Promise<
    | (
        | ({ registro: "receta"; fecha: Date } & Receta)
        | ({ registro: "venta" } & Omit<Venta, "stock_descontado" | "items"> & {
              items: (ItemVenta & { nombre_producto: string })[];
            })
      )[]
    | null
  > {
    const { records } = await this.neo4j.executeQuery(
      `MATCH (c:Cliente {id_cliente: $idCliente})
       OPTIONAL MATCH (c)<-[:EMITIDA_PARA|DE_CLIENTE]-(h)
       OPTIONAL MATCH (h)-[:ATENDIDA_POR]->(f:Farmaceutico)
       OPTIONAL MATCH (h)-[:CON_RECETA]->(r:Receta)
       CALL (h) {
         MATCH (h)-[i:INCLUYE]->(p:Producto)
         WITH i, p
         ORDER BY i.id_detalle
         RETURN collect(i {
           .id_detalle, id_producto: p.id_producto, nombre_producto: p.nombre, .cantidad, .precio_unit
         }) AS items
       }
       WITH c, h, f, r, items
       ORDER BY coalesce(h.fecha, h.fecha_emision), h:Venta, coalesce(h.id_venta, h.id_receta)
       RETURN c.id_cliente AS idCliente, collect(CASE WHEN h IS NULL THEN null ELSE {
         nodo: h, esVenta: h:Venta, idFarmaceutico: f.id_farmaceutico, idReceta: r.id_receta,
         items: items
       } END) AS historial`,
      { idCliente },
      { routing: neo4j.routing.READ },
    );
    if (records.length === 0) return null;
    const filas: {
      nodo: Node;
      esVenta: boolean;
      idFarmaceutico: string | null;
      idReceta: string | null;
      items: (ItemVenta & { nombre_producto: string })[];
    }[] = records[0].get("historial");
    return filas.map((fila) => {
      if (!fila.esVenta) {
        const receta = recetaDesdeNodo(fila.nodo, idCliente);
        return { registro: "receta" as const, fecha: receta.fecha_emision, ...receta };
      }
      const items = fila.items.map((item) => ({
        id_detalle: item.id_detalle,
        id_producto: item.id_producto,
        nombre_producto: item.nombre_producto,
        cantidad: item.cantidad,
        precio_unit: item.precio_unit,
      }));
      const venta = ventaDesdeNodo(fila.nodo, {
        idCliente,
        idFarmaceutico: fila.idFarmaceutico!,
        idReceta: fila.idReceta,
        items,
      });
      return { registro: "venta" as const, ...venta, items };
    });
  }

  /** Rechaza la operación si algún cliente, activo o dado de baja, ya tiene ese DNI. */
  private async rechazarSiDniRegistrado(dni: string): Promise<void> {
    const existente = await this.coleccion.findOne({ dni });
    if (existente) {
      const estado = existente.activo ? "activo" : "dado de baja";
      throw new OperacionRechazada(`ya existe un cliente con DNI ${dni}: ${existente._id} (${estado})`);
    }
  }

  /**
   * Escribe la copia de un cliente en Neo4j. Se llama después de confirmar la escritura en MongoDB:
   * si falla, MongoDB ya quedó escrito y la copia se reconstruye con `npm run sync`.
   */
  private async copiar(cliente: Cliente): Promise<void> {
    try {
      await this.neo4j.executeQuery(
        "MERGE (c:Cliente {id_cliente: $nodo.id_cliente}) SET c = $nodo",
        { nodo: aNodo(cliente) },
      );
    } catch (error) {
      throw new Error(
        `El cliente ${cliente._id} quedó guardado en MongoDB, pero no se pudo actualizar su copia ` +
          "en Neo4j. Ejecutá `npm run sync` para reconstruirla desde MongoDB.",
        { cause: error },
      );
    }
  }

  /** Deja en el grafo exactamente estos clientes, en una única transacción. */
  private async copiarAlGrafo(clientes: Cliente[]): Promise<void> {
    await asegurarIdUnico(this.neo4j, "Cliente", "id_cliente");
    await enTransaccion(this.neo4j, async (tx) => {
      await tx.run("MATCH (c:Cliente) WHERE NOT c.id_cliente IN $ids DETACH DELETE c", {
        ids: clientes.map((cliente) => cliente._id),
      });
      await tx.run(
        `UNWIND $nodos AS nodo
         MERGE (c:Cliente {id_cliente: nodo.id_cliente})
         SET c = nodo`,
        { nodos: clientes.map(aNodo) },
      );
    });
  }
}

/**
 * Propiedades del nodo (:Cliente). Neo4j no guarda propiedades nulas: un cliente sin cobertura
 * queda sin `nro_afiliado` en el nodo.
 */
function aNodo(cliente: Cliente) {
  return {
    id_cliente: cliente._id,
    nombre: cliente.nombre,
    apellido: cliente.apellido,
    dni: cliente.dni,
    email: cliente.email,
    telefono: cliente.telefono,
    ciudad: cliente.ciudad,
    provincia: cliente.provincia,
    obra_social: cliente.obra_social,
    nro_afiliado: cliente.nro_afiliado,
    activo: cliente.activo,
  };
}

/**
 * Convierte un nodo (:Cliente) al tipo del dominio. El nodo no guarda `nro_afiliado` cuando el
 * cliente no tiene cobertura: vuelve como null.
 */
export function clienteDesdeNodo(nodo: Node): Cliente {
  const c = nodo.properties;
  return {
    _id: c.id_cliente,
    nombre: c.nombre,
    apellido: c.apellido,
    dni: c.dni,
    email: c.email,
    telefono: c.telefono,
    ciudad: c.ciudad,
    provincia: c.provincia,
    obra_social: c.obra_social,
    nro_afiliado: c.nro_afiliado ?? null,
    activo: c.activo,
  };
}

/** Si `error` es el de clave duplicada de MongoDB (código 11000) sobre el índice de `campo`. */
function esClaveDuplicada(error: unknown, campo: string): boolean {
  return error instanceof MongoServerError && error.code === 11000 && campo in (error.keyPattern ?? {});
}
