// Ejecuta una consulta e imprime el resultado como JSON.
// Uso: npm run query -- <número> [parámetros...]   (ej. npm run query -- 1)
// Los servicios que rechazan una operación imprimen "Rechazado: <motivo>" y terminan con código 1.

import { connectMongo, connectNeo4j } from "../src/lib/db.js";
import { OperacionRechazada } from "../src/lib/errores.js";
import { crearRepositorios, type Repositorios } from "../src/lib/repositorios.js";
import { q01ProductosActivosConProveedor } from "../src/queries/q01.js";
import { q02VentasPendientesConFarmaceutico } from "../src/queries/q02.js";
import { q03HistorialCliente } from "../src/queries/q03.js";
import { q04ClientesConVariasRecetas } from "../src/queries/q04.js";
import { q08LotesConStockBajo } from "../src/queries/q08.js";
import {
  CAMPOS_ALTA,
  CAMPOS_MODIFICABLES,
  q13AltaCliente,
  q13BajaCliente,
  q13ModificarCliente,
} from "../src/queries/q13.js";

type Consulta = (repos: Repositorios, args: string[]) => Promise<unknown>;

const consultas: Record<number, Consulta> = {
  1: ({ productos }) => q01ProductosActivosConProveedor(productos),
  2: ({ ventas }) => q02VentasPendientesConFarmaceutico(ventas),
  3: ({ clientes, ventas, recetas }, args) =>
    q03HistorialCliente(clientes, ventas, recetas, parametro(args, 0, "id_cliente")),
  4: ({ recetas }) => q04ClientesConVariasRecetas(recetas),
  8: ({ lotes }) => q08LotesConStockBajo(lotes),
  // 13 alta campo=valor ...  |  13 modificar <id_cliente> campo=valor ...  |  13 baja <id_cliente>
  13: ({ clientes }, [operacion, ...resto]) => {
    if (operacion === "alta") {
      const datos = campos(resto, CAMPOS_ALTA) as Parameters<typeof q13AltaCliente>[1];
      return q13AltaCliente(clientes, datos);
    }
    if (operacion === "modificar") {
      const [idCliente = "", ...pares] = resto;
      const cambios = campos(pares, CAMPOS_MODIFICABLES) as Parameters<typeof q13ModificarCliente>[2];
      return q13ModificarCliente(clientes, idCliente, cambios);
    }
    if (operacion === "baja") return q13BajaCliente(clientes, resto[0] ?? "");
    throw new OperacionRechazada("la operación tiene que ser alta, modificar o baja");
  },
};

const [numero, ...args] = process.argv.slice(2);
const consulta = consultas[Number(numero?.replace(/^q/i, ""))];
if (!consulta) {
  console.error(`Uso: npm run query -- <número>. Disponibles: ${Object.keys(consultas).join(", ")}`);
  process.exit(1);
}

const mongo = await connectMongo();
const neo4j = await connectNeo4j();

try {
  const resultado = await consulta(crearRepositorios(mongo.db(), neo4j), args);
  console.log(JSON.stringify(resultado, null, 2));
} catch (error) {
  if (!(error instanceof OperacionRechazada)) throw error;
  console.error(`Rechazado: ${error.message}`);
  process.exitCode = 1;
} finally {
  await neo4j.close();
  await mongo.close();
}

function parametro(args: string[], posicion: number, nombre: string): string {
  const valor = args[posicion];
  if (!valor) throw new Error(`Falta el parámetro ${nombre}`);
  return valor;
}

/**
 * Convierte argumentos `campo=valor` en un objeto. Un valor vacío (`campo=`) se toma como null,
 * igual que un campo vacío en los CSV. Rechaza campos desconocidos o repetidos.
 */
function campos(pares: string[], permitidos: readonly string[]): Record<string, string | null> {
  const resultado: Record<string, string | null> = {};
  for (const par of pares) {
    const separador = par.indexOf("=");
    const campo = separador === -1 ? par : par.slice(0, separador);
    if (separador === -1 || !permitidos.includes(campo) || campo in resultado) {
      throw new OperacionRechazada(
        `"${par}" no es válido: se espera campo=valor, sin repetir, con campo en ${permitidos.join(", ")}`,
      );
    }
    resultado[campo] = par.slice(separador + 1) || null;
  }
  return resultado;
}
