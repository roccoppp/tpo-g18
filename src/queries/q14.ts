import type { ClientesRepository } from "../clientes/repository.js";
import type { FarmaceuticosRepository } from "../farmaceuticos/repository.js";
import { OperacionRechazada } from "../lib/errores.js";
import { hoy } from "../lib/fechas.js";
import type { Repositorios } from "../lib/repositorios.js";
import type { Lote } from "../lotes/types.js";
import type { ProductosRepository } from "../productos/repository.js";
import type { Producto } from "../productos/types.js";
import type { RecetasRepository } from "../recetas/repository.js";
import type { Receta } from "../recetas/types.js";
import { MEDIOS_PAGO, type Venta } from "../ventas/types.js";
import { descontarStockDeVenta } from "./q15.js";

// Q14: registro de una venta 'Completada' (cabecera e ítems).
//
// Motores: MongoDB (ventas, recetas, lotes, clientes y productos, la fuente de verdad) y Neo4j (el
// farmacéutico y su sucursal, que solo están en el grafo, y las copias de la venta y los lotes).
// Todas las validaciones se hacen antes de escribir. La venta, la dispensa de la receta y el
// descuento de stock (q15) se escriben en una única transacción de MongoDB: si el stock no
// alcanza, no queda la venta ni la receta modificada. Después de confirmarla se escriben las
// copias en Neo4j.

/**
 * Q14: registra una venta 'Completada' con fecha de hoy.
 *
 * Valida que el cliente exista y esté activo; que el farmacéutico exista, esté activo y trabaje en
 * una sucursal de tipo 'Farmacia'; que los productos existan, estén activos y no se repitan, con
 * cantidades enteras positivas; y, si algún producto es 'Bajo receta' o 'Bajo receta archivada',
 * que la receta exista, esté 'Vigente' y sea del mismo cliente. Si se indica una receta pero
 * ningún producto la requiere, rechaza la venta, para no consumir una dispensa sin uso.
 *
 * Cada ítem toma el precio de lista vigente del producto, y el total es la suma de los ítems. Si
 * hay receta, registra la dispensa según las reglas de negocio (ver RecetasRepository.dispensar).
 * En la misma transacción descuenta el stock de la venta con q15 (FEFO, sin lotes vencidos): si
 * no alcanza para algún ítem, rechaza la venta completa.
 *
 * @param datos cliente, farmacéutico, medio de pago, receta (null en una venta libre) e ítems.
 * @returns la venta registrada; si tiene receta, la receta antes y después de la dispensa; y cada
 *   lote modificado, antes y después del descuento.
 */
export async function q14RegistrarVenta(
  {
    clientes,
    farmaceuticos,
    productos,
    recetas,
    ventas,
    lotes,
    transacciones,
  }: Pick<
    Repositorios,
    "clientes" | "farmaceuticos" | "productos" | "recetas" | "ventas" | "lotes" | "transacciones"
  >,
  datos: {
    id_cliente: string;
    id_farmaceutico: string;
    medio_pago: string;
    id_receta: string | null;
    items: { id_producto: string; cantidad: number }[];
  },
): Promise<{
  venta: Venta;
  receta: { antes: Receta; despues: Receta } | null;
  lotes: { antes: Lote; despues: Lote }[];
}> {
  const medioPago = medioDePago(datos.medio_pago);
  rechazarSiItemsInvalidos(datos.items);
  await rechazarSiClienteNoActivo(clientes, datos.id_cliente);
  await rechazarSiFarmaceuticoNoHabilitado(farmaceuticos, datos.id_farmaceutico);
  const catalogo = await productosActivos(productos, datos.items);
  const receta = await recetaDeLaVenta(recetas, datos.id_receta, datos.id_cliente, catalogo);

  const fecha = hoy();
  const items = datos.items.map(({ id_producto, cantidad }) => ({
    id_producto,
    cantidad,
    precio_unit: catalogo.get(id_producto)!.precio_unit,
  }));
  const resultado = await transacciones.ejecutar(async (session) => {
    const venta = await ventas.registrar(
      {
        id_cliente: datos.id_cliente,
        id_farmaceutico: datos.id_farmaceutico,
        id_receta: receta?._id ?? null,
        fecha,
        tipo: receta ? "Con receta" : "Venta libre",
        medio_pago: medioPago,
        total: items.reduce((suma, item) => suma + item.cantidad * item.precio_unit, 0),
        estado: "Completada",
        items,
        stock_descontado: false,
      },
      session,
    );
    const dispensa = receta
      ? { antes: receta, despues: await recetas.dispensar(receta, fecha, session) }
      : null;
    const stock = await descontarStockDeVenta({ ventas, farmaceuticos, lotes }, venta._id, session);
    return { venta: stock.venta, receta: dispensa, lotes: stock.lotes };
  });
  await ventas.copiar(resultado.venta);
  await lotes.copiarUnidades(resultado.lotes.map((lote) => lote.despues));
  return resultado;
}

/** El medio de pago, si es uno de los admitidos. Si no, rechaza la venta. */
function medioDePago(medioPago: string): Venta["medio_pago"] {
  const admitido = MEDIOS_PAGO.find((medio) => medio === medioPago);
  if (!admitido) {
    throw new OperacionRechazada(`el medio de pago tiene que ser ${MEDIOS_PAGO.join(", ")}`);
  }
  return admitido;
}

/** Rechaza la venta si no tiene ítems, si un producto se repite o si una cantidad no es válida. */
function rechazarSiItemsInvalidos(items: { id_producto: string; cantidad: number }[]): void {
  if (items.length === 0) throw new OperacionRechazada("la venta tiene que tener al menos un ítem");
  const vistos = new Set<string>();
  for (const { id_producto, cantidad } of items) {
    if (vistos.has(id_producto)) {
      throw new OperacionRechazada(`el producto ${id_producto} aparece más de una vez`);
    }
    vistos.add(id_producto);
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new OperacionRechazada(
        `la cantidad de ${id_producto} tiene que ser un entero positivo`,
      );
    }
  }
}

async function rechazarSiClienteNoActivo(clientes: ClientesRepository, idCliente: string): Promise<void> {
  const cliente = await clientes.buscarPorId(idCliente);
  if (!cliente) throw new OperacionRechazada(`no existe el cliente ${idCliente}`);
  if (!cliente.activo) throw new OperacionRechazada(`el cliente ${idCliente} está dado de baja`);
}

/** Rechaza la venta si el farmacéutico no existe, no está activo o no trabaja en una farmacia. */
async function rechazarSiFarmaceuticoNoHabilitado(
  farmaceuticos: FarmaceuticosRepository,
  idFarmaceutico: string,
): Promise<void> {
  const encontrado = await farmaceuticos.buscarConSucursal(idFarmaceutico);
  if (!encontrado) throw new OperacionRechazada(`no existe el farmacéutico ${idFarmaceutico}`);
  const { farmaceutico, sucursal } = encontrado;
  if (!farmaceutico.activo) {
    throw new OperacionRechazada(`el farmacéutico ${idFarmaceutico} no está activo`);
  }
  if (sucursal.tipo !== "Farmacia") {
    throw new OperacionRechazada(
      `el farmacéutico ${idFarmaceutico} trabaja en ${sucursal.id_sucursal} (${sucursal.tipo}), ` +
        "y solo se registran ventas en sucursales de tipo 'Farmacia'",
    );
  }
}

/** Los productos de la venta, por id, si todos existen y están activos. Si no, rechaza la venta. */
async function productosActivos(
  productos: ProductosRepository,
  items: { id_producto: string }[],
): Promise<Map<string, Producto>> {
  const encontrados = await productos.buscarPorIds(items.map((item) => item.id_producto));
  const porId = new Map(encontrados.map((producto) => [producto._id, producto]));
  for (const { id_producto } of items) {
    const producto = porId.get(id_producto);
    if (!producto) throw new OperacionRechazada(`no existe el producto ${id_producto}`);
    if (!producto.activo) {
      throw new OperacionRechazada(`el producto ${id_producto} está discontinuado`);
    }
  }
  return porId;
}

/**
 * La receta de la venta, o null en una venta libre. Si algún producto requiere receta, exige una
 * receta existente, 'Vigente' y del mismo cliente. Si se indica una receta pero ningún producto la
 * requiere, rechaza la venta.
 */
async function recetaDeLaVenta(
  recetas: RecetasRepository,
  idReceta: string | null,
  idCliente: string,
  catalogo: Map<string, Producto>,
): Promise<Receta | null> {
  const bajoReceta = [...catalogo.values()]
    .filter((producto) => producto.condicion_venta !== "Venta libre")
    .map((producto) => producto._id);
  if (bajoReceta.length === 0) {
    if (idReceta) {
      throw new OperacionRechazada(
        `ningún producto de la venta requiere receta, así que no corresponde indicar ${idReceta}`,
      );
    }
    return null;
  }
  if (!idReceta) {
    const productosBajoReceta =
      bajoReceta.length === 1
        ? `el producto ${bajoReceta[0]} se vende`
        : `los productos ${bajoReceta.join(", ")} se venden`;
    throw new OperacionRechazada(`${productosBajoReceta} solo con receta`);
  }
  const receta = await recetas.buscarPorId(idReceta);
  if (!receta) throw new OperacionRechazada(`no existe la receta ${idReceta}`);
  if (receta.id_cliente !== idCliente) {
    throw new OperacionRechazada(`la receta ${idReceta} es de otro cliente (${receta.id_cliente})`);
  }
  if (receta.estado !== "Vigente") {
    throw new OperacionRechazada(`la receta ${idReceta} no está vigente (${receta.estado})`);
  }
  return receta;
}
