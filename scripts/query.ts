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
import { q05FarmaceuticosConVentasRecientes } from "../src/queries/q05.js";
import { q06RecetasProlongadasAtrasadas } from "../src/queries/q06.js";
import { q07TopProductosVendidos } from "../src/queries/q07.js";
import { q08LotesConStockBajo } from "../src/queries/q08.js";
import { q09VentasLibresMenoresA5000 } from "../src/queries/q09.js";
import { q10ClientesDeSucursal } from "../src/queries/q10.js";
import { q11IngresosPorFarmaceuticoMesActual } from "../src/queries/q11.js";
import { q12ClientesSinVentasUltimoAnio } from "../src/queries/q12.js";
import {
  CAMPOS_ALTA,
  CAMPOS_MODIFICABLES,
  q13AltaCliente,
  q13BajaCliente,
  q13ModificarCliente,
} from "../src/queries/q13.js";
import { q14RegistrarVenta } from "../src/queries/q14.js";

type Consulta = (repos: Repositorios, args: string[]) => Promise<unknown>;

const consultas: Record<number, Consulta> = {
  1: ({ productos }) => q01ProductosActivosConProveedor(productos),
  2: ({ ventas }) => q02VentasPendientesConFarmaceutico(ventas),
  3: ({ clientes, ventas, recetas }, args) =>
    q03HistorialCliente(clientes, ventas, recetas, parametro(args, 0, "id_cliente")),
  4: ({ recetas }) => q04ClientesConVariasRecetas(recetas),
  5: ({ farmaceuticos }) => q05FarmaceuticosConVentasRecientes(farmaceuticos),
  6: ({ recetas }) => q06RecetasProlongadasAtrasadas(recetas),
  7: ({ ventas }) => q07TopProductosVendidos(ventas),
  8: ({ lotes }) => q08LotesConStockBajo(lotes),
  9: ({ ventas }) => q09VentasLibresMenoresA5000(ventas),
  10: ({ clientes }, args) => q10ClientesDeSucursal(clientes, parametro(args, 0, "id_sucursal")),
  11: ({ ventas, farmaceuticos }) => q11IngresosPorFarmaceuticoMesActual(ventas, farmaceuticos),
  12: ({ clientes }) => q12ClientesSinVentasUltimoAnio(clientes),
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
  // 14 <id_cliente> <id_farmaceutico> <medio_pago> [receta=<id_receta>] <id_producto>:<cantidad> ...
  14: (repos, args) => {
    const [, , , ...resto] = args;
    const receta = resto.find((arg) => arg.startsWith("receta="));
    return q14RegistrarVenta(repos, {
      id_cliente: parametro(args, 0, "id_cliente"),
      id_farmaceutico: parametro(args, 1, "id_farmaceutico"),
      medio_pago: parametro(args, 2, "medio_pago"),
      id_receta: receta ? receta.slice("receta=".length) || null : null,
      items: itemsDeVenta(resto.filter((arg) => arg !== receta)),
    });
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

/**
 * Convierte argumentos `id_producto:cantidad` en los ítems de una venta. La cantidad se valida en
 * q14: acá solo se rechaza un argumento sin el formato.
 */
function itemsDeVenta(pares: string[]): { id_producto: string; cantidad: number }[] {
  return pares.map((par) => {
    const [idProducto, cantidad, ...sobrante] = par.split(":");
    if (!idProducto || cantidad === undefined || sobrante.length > 0) {
      throw new OperacionRechazada(`"${par}" no es válido: se espera id_producto:cantidad`);
    }
    return { id_producto: idProducto, cantidad: Number(cantidad) };
  });
}
