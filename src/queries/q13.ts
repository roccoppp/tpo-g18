import type { ClientesRepository } from "../clientes/repository.js";
import { problemasDeCliente, type Cliente } from "../clientes/types.js";
import { OperacionRechazada } from "../lib/errores.js";

/** Campos que recibe el alta: todos menos el id (lo asigna el sistema) y `activo` (empieza en true). */
export const CAMPOS_ALTA = [
  "nombre",
  "apellido",
  "dni",
  "email",
  "telefono",
  "ciudad",
  "provincia",
  "obra_social",
  "nro_afiliado",
] as const;

/** Campos que se pueden modificar: los de contacto y los de cobertura. */
export const CAMPOS_MODIFICABLES = ["email", "telefono", "obra_social", "nro_afiliado"] as const;

// Q13: ABM de clientes. Tres operaciones: alta, modificación y baja lógica.
//
// Motores: MongoDB (fuente de verdad) y Neo4j (copia). Cada operación escribe primero en MongoDB y
// después actualiza el nodo (:Cliente) del grafo. Todas devuelven el estado del cliente antes y
// después. Si una validación no pasa, lanzan OperacionRechazada sin modificar ningún dato.

/**
 * Q13, alta: registra un cliente activo y le asigna el próximo id (C001, C002, ...).
 *
 * Valida campos obligatorios, formatos (DNI, email, teléfono), que la obra social sea una de las
 * admitidas y que el número de afiliado esté vacío si y solo si no tiene cobertura. El DNI único
 * lo garantiza el índice único de MongoDB, también frente a un DNI de un cliente dado de baja.
 *
 * @param datos los datos del cliente, sin id ni `activo`.
 * @returns `antes` en null (el cliente no existía) y `despues` con el cliente creado.
 */
export async function q13AltaCliente(
  clientes: ClientesRepository,
  datos: Omit<Cliente, "_id" | "activo">,
): Promise<{ antes: null; despues: Cliente }> {
  rechazarSiHayProblemas(problemasDeCliente(datos));
  return { antes: null, despues: await clientes.alta(datos) };
}

/**
 * Q13, modificación: cambia datos de contacto (email, teléfono) y de cobertura (obra social, número
 * de afiliado) de un cliente activo. Nombre, apellido, DNI y domicilio no se modifican.
 *
 * Valida el cliente como queda después del cambio, así que cambiar la obra social a 'Sin cobertura'
 * exige vaciar también el número de afiliado. Si otra escritura modifica el cliente mientras tanto,
 * rechaza en lugar de pisarla.
 *
 * @param idCliente el cliente a modificar.
 * @param cambios los campos a modificar, con su valor nuevo.
 * @returns el cliente antes y después del cambio.
 */
export async function q13ModificarCliente(
  clientes: ClientesRepository,
  idCliente: string,
  cambios: Partial<Pick<Cliente, (typeof CAMPOS_MODIFICABLES)[number]>>,
): Promise<{ antes: Cliente; despues: Cliente }> {
  const campos = Object.keys(cambios);
  const noModificables = campos.filter(
    (campo) => !(CAMPOS_MODIFICABLES as readonly string[]).includes(campo),
  );
  if (campos.length === 0 || noModificables.length > 0) {
    throw new OperacionRechazada(
      `solo se modifican ${CAMPOS_MODIFICABLES.join(", ")}` +
        (noModificables.length > 0 ? `; no se puede modificar ${noModificables.join(", ")}` : ""),
    );
  }
  const antes = await clienteActivo(clientes, idCliente);
  rechazarSiHayProblemas(problemasDeCliente({ ...antes, ...cambios }));
  return { antes, despues: await clientes.actualizar(antes, cambios) };
}

/**
 * Q13, baja lógica: marca un cliente activo con `activo: false`. El cliente no se borra: sus
 * ventas y recetas lo siguen referenciando, y su DNI sigue registrado.
 *
 * @param idCliente el cliente a dar de baja.
 * @returns el cliente antes y después de la baja.
 */
export async function q13BajaCliente(
  clientes: ClientesRepository,
  idCliente: string,
): Promise<{ antes: Cliente; despues: Cliente }> {
  const antes = await clienteActivo(clientes, idCliente);
  return { antes, despues: await clientes.actualizar(antes, { activo: false }) };
}

/** El cliente `idCliente`, si existe y está activo. Si no, rechaza la operación. */
async function clienteActivo(clientes: ClientesRepository, idCliente: string): Promise<Cliente> {
  const cliente = await clientes.buscarPorId(idCliente);
  if (!cliente) throw new OperacionRechazada(`no existe el cliente ${idCliente}`);
  if (!cliente.activo) throw new OperacionRechazada(`el cliente ${idCliente} está dado de baja`);
  return cliente;
}

function rechazarSiHayProblemas(problemas: string[]): void {
  if (problemas.length > 0) throw new OperacionRechazada(problemas.join("; "));
}
