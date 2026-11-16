// Carga idempotente: borra y vuelve a cargar cada entidad a partir de
// data/provistos y data/adicionales. Se puede ejecutar cuantas veces se quiera.

import { OBRAS_SOCIALES, problemasDeCliente, type Cliente } from "../src/clientes/types.js";
import { CARGOS_FARMACEUTICO, type Farmaceutico } from "../src/farmaceuticos/types.js";
import {
  booleano,
  entero,
  fecha,
  leerDataset,
  opcional,
  requerido,
  unoDe,
  type Fila,
} from "../src/lib/csv.js";
import { connectMongo, connectNeo4j } from "../src/lib/db.js";
import { crearRepositorios } from "../src/lib/repositorios.js";
import type { Lote } from "../src/lotes/types.js";
import { CONDICIONES_VENTA, type Producto } from "../src/productos/types.js";
import { TIPOS_PROVEEDOR, type Proveedor } from "../src/proveedores/types.js";
import { ESTADOS_RECETA, TIPOS_RECETA, type Receta } from "../src/recetas/types.js";
import { TIPOS_SUCURSAL, type Sucursal } from "../src/sucursales/types.js";
import {
  ESTADOS_VENTA,
  MEDIOS_PAGO,
  TIPOS_VENTA,
  type ItemVenta,
  type Venta,
} from "../src/ventas/types.js";

// Los motores no validan referencias entre sí: se valida todo antes de escribir.
const proveedores = leerDataset("proveedores").map(proveedorDesdeFila);
const sucursales = leerDataset("sucursales").map(sucursalDesdeFila);
const productos = leerDataset("productos").map(productoDesdeFila);
const lotes = leerDataset("stock_lotes").map(loteDesdeFila);
const clientes = leerDataset("clientes").map(clienteDesdeFila);
const farmaceuticos = leerDataset("farmaceuticos").map(farmaceuticoDesdeFila);
const recetas = leerDataset("recetas").map(recetaDesdeFila);
const ventas = leerDataset("ventas").map(ventaDesdeFila);
const detalle = leerDataset("detalle_ventas");

const idsProveedor = idsUnicos("proveedores", proveedores.map((p) => p.id_proveedor));
const idsSucursal = idsUnicos("sucursales", sucursales.map((s) => s.id_sucursal));
const idsProducto = idsUnicos("productos", productos.map((p) => p._id));
idsUnicos("stock_lotes", lotes.map((l) => l._id));
const idsCliente = idsUnicos("clientes", clientes.map((c) => c._id));
idsUnicos("clientes", clientes.map((c) => c.dni), "dni");
const idsFarmaceutico = idsUnicos("farmaceuticos", farmaceuticos.map((f) => f.id_farmaceutico));
idsUnicos("farmaceuticos", farmaceuticos.map((f) => f.matricula), "matrículas");
const idsReceta = idsUnicos("recetas", recetas.map((r) => r._id));
idsUnicos("ventas", ventas.map((v) => v._id));
idsUnicos("detalle_ventas", detalle.map((fila) => requerido(fila, "id_detalle")));
for (const producto of productos) {
  if (!idsProveedor.has(producto.id_proveedor)) {
    throw new Error(`Producto ${producto._id}: no existe el proveedor ${producto.id_proveedor}`);
  }
}
for (const lote of lotes) {
  if (!idsProducto.has(lote.id_producto)) {
    throw new Error(`Lote ${lote._id}: no existe el producto ${lote.id_producto}`);
  }
  if (!idsSucursal.has(lote.id_sucursal)) {
    throw new Error(`Lote ${lote._id}: no existe la sucursal ${lote.id_sucursal}`);
  }
  if (lote.unidades < 0) {
    throw new Error(`Lote ${lote._id}: unidades negativas (${lote.unidades})`);
  }
}
for (const cliente of clientes) {
  const problemas = problemasDeCliente(cliente);
  if (problemas.length > 0) {
    throw new Error(`Cliente ${cliente._id}: ${problemas.join("; ")}`);
  }
}
for (const farmaceutico of farmaceuticos) {
  if (!idsSucursal.has(farmaceutico.id_sucursal)) {
    throw new Error(
      `Farmacéutico ${farmaceutico.id_farmaceutico}: no existe la sucursal ${farmaceutico.id_sucursal}`,
    );
  }
}
for (const receta of recetas) {
  if (!idsCliente.has(receta.id_cliente)) {
    throw new Error(`Receta ${receta._id}: no existe el cliente ${receta.id_cliente}`);
  }
}
// Cada fila del detalle se embebe como ítem en el documento de su venta.
const ventasPorId = new Map(ventas.map((venta) => [venta._id, venta]));
for (const fila of detalle) {
  const venta = ventasPorId.get(requerido(fila, "id_venta"));
  if (!venta) throw new Error(`Detalle ${fila.id_detalle}: no existe la venta ${fila.id_venta}`);
  venta.items.push(itemDesdeFila(fila));
}
for (const venta of ventas) {
  if (!idsCliente.has(venta.id_cliente)) {
    throw new Error(`Venta ${venta._id}: no existe el cliente ${venta.id_cliente}`);
  }
  if (!idsFarmaceutico.has(venta.id_farmaceutico)) {
    throw new Error(`Venta ${venta._id}: no existe el farmacéutico ${venta.id_farmaceutico}`);
  }
  if (venta.id_receta !== null && !idsReceta.has(venta.id_receta)) {
    throw new Error(`Venta ${venta._id}: no existe la receta ${venta.id_receta}`);
  }
  for (const item of venta.items) {
    if (!idsProducto.has(item.id_producto)) {
      throw new Error(`Venta ${venta._id}: no existe el producto ${item.id_producto}`);
    }
  }
  const suma = venta.items.reduce((acum, item) => acum + item.cantidad * item.precio_unit, 0);
  if (venta.total !== suma) {
    throw new Error(`Venta ${venta._id}: el total ${venta.total} no coincide con sus ítems (${suma})`);
  }
}

const mongo = await connectMongo();
const neo4j = await connectNeo4j();

try {
  const repos = crearRepositorios(mongo.db(), neo4j);

  // Primero los nodos que solo viven en Neo4j: los productos y los lotes se relacionan con ellos.
  await repos.proveedores.reemplazarTodos(proveedores);
  console.log(`Neo4j: ${proveedores.length} proveedores`);

  await repos.sucursales.reemplazarTodas(sucursales);
  console.log(`Neo4j: ${sucursales.length} sucursales`);

  await repos.productos.reemplazarTodos(productos);
  console.log(`MongoDB + copia en Neo4j: ${productos.length} productos`);

  await repos.lotes.reemplazarTodos(lotes);
  console.log(`MongoDB + copia en Neo4j: ${lotes.length} lotes`);

  await repos.clientes.reemplazarTodos(clientes);
  console.log(`MongoDB + copia en Neo4j: ${clientes.length} clientes`);

  // Los farmacéuticos se relacionan con las sucursales, las recetas con los clientes, y las ventas
  // con los farmacéuticos, los clientes, las recetas y los productos (cargados antes).
  await repos.farmaceuticos.reemplazarTodos(farmaceuticos);
  console.log(`Neo4j: ${farmaceuticos.length} farmacéuticos`);

  await repos.recetas.reemplazarTodas(recetas);
  console.log(`MongoDB + copia en Neo4j: ${recetas.length} recetas`);

  await repos.ventas.reemplazarTodas(ventas);
  console.log(`MongoDB + copia en Neo4j: ${ventas.length} ventas`);
} finally {
  await neo4j.close();
  await mongo.close();
}

function proveedorDesdeFila(fila: Fila): Proveedor {
  return {
    id_proveedor: requerido(fila, "id_proveedor"),
    razon_social: requerido(fila, "razon_social"),
    cuit: requerido(fila, "cuit"),
    tipo: unoDe(fila, "tipo", TIPOS_PROVEEDOR),
    ciudad: requerido(fila, "ciudad"),
    provincia: requerido(fila, "provincia"),
    telefono: requerido(fila, "telefono"),
    activo: booleano(fila, "activo"),
  };
}

function sucursalDesdeFila(fila: Fila): Sucursal {
  return {
    id_sucursal: requerido(fila, "id_sucursal"),
    nombre: requerido(fila, "nombre"),
    tipo: unoDe(fila, "tipo", TIPOS_SUCURSAL),
    direccion: requerido(fila, "direccion"),
    ciudad: requerido(fila, "ciudad"),
    provincia: requerido(fila, "provincia"),
    telefono: requerido(fila, "telefono"),
    activo: booleano(fila, "activo"),
  };
}

function productoDesdeFila(fila: Fila): Producto {
  return {
    _id: requerido(fila, "id_producto"),
    nombre: requerido(fila, "nombre"),
    principio_activo: requerido(fila, "principio_activo"),
    categoria: requerido(fila, "categoria"),
    presentacion: requerido(fila, "presentacion"),
    condicion_venta: unoDe(fila, "condicion_venta", CONDICIONES_VENTA),
    precio_unit: entero(fila, "precio_unit"),
    id_proveedor: requerido(fila, "id_proveedor"),
    activo: booleano(fila, "activo"),
  };
}

function loteDesdeFila(fila: Fila): Lote {
  return {
    _id: requerido(fila, "id_lote"),
    id_producto: requerido(fila, "id_producto"),
    id_sucursal: requerido(fila, "id_sucursal"),
    nro_lote: requerido(fila, "nro_lote"),
    unidades: entero(fila, "unidades"),
    vencimiento: fecha(fila, "vencimiento"),
  };
}

function clienteDesdeFila(fila: Fila): Cliente {
  return {
    _id: requerido(fila, "id_cliente"),
    nombre: requerido(fila, "nombre"),
    apellido: requerido(fila, "apellido"),
    dni: requerido(fila, "dni"),
    email: requerido(fila, "email"),
    telefono: requerido(fila, "telefono"),
    ciudad: requerido(fila, "ciudad"),
    provincia: requerido(fila, "provincia"),
    obra_social: unoDe(fila, "obra_social", OBRAS_SOCIALES),
    nro_afiliado: opcional(fila, "nro_afiliado"),
    activo: booleano(fila, "activo"),
  };
}

function farmaceuticoDesdeFila(fila: Fila): Farmaceutico {
  return {
    id_farmaceutico: requerido(fila, "id_farmaceutico"),
    nombre: requerido(fila, "nombre"),
    apellido: requerido(fila, "apellido"),
    matricula: requerido(fila, "matricula"),
    cargo: unoDe(fila, "cargo", CARGOS_FARMACEUTICO),
    id_sucursal: requerido(fila, "id_sucursal"),
    activo: booleano(fila, "activo"),
  };
}

function recetaDesdeFila(fila: Fila): Receta {
  return {
    _id: requerido(fila, "id_receta"),
    id_cliente: requerido(fila, "id_cliente"),
    medico: requerido(fila, "medico"),
    matricula_medico: requerido(fila, "matricula_medico"),
    fecha_emision: fecha(fila, "fecha_emision"),
    tipo: unoDe(fila, "tipo", TIPOS_RECETA),
    dispensas_autorizadas: entero(fila, "dispensas_autorizadas"),
    dispensas_realizadas: entero(fila, "dispensas_realizadas"),
    proxima_dispensa:
      opcional(fila, "proxima_dispensa") === null ? null : fecha(fila, "proxima_dispensa"),
    estado: unoDe(fila, "estado", ESTADOS_RECETA),
  };
}

/** La venta sale sin ítems: se completan con las filas de detalle_ventas. */
function ventaDesdeFila(fila: Fila): Venta {
  return {
    _id: requerido(fila, "id_venta"),
    id_cliente: requerido(fila, "id_cliente"),
    id_farmaceutico: requerido(fila, "id_farmaceutico"),
    id_receta: opcional(fila, "id_receta"),
    fecha: fecha(fila, "fecha"),
    tipo: unoDe(fila, "tipo", TIPOS_VENTA),
    medio_pago: unoDe(fila, "medio_pago", MEDIOS_PAGO),
    total: entero(fila, "total"),
    estado: unoDe(fila, "estado", ESTADOS_VENTA),
    items: [],
    stock_descontado: false,
  };
}

function itemDesdeFila(fila: Fila): ItemVenta {
  return {
    id_detalle: requerido(fila, "id_detalle"),
    id_producto: requerido(fila, "id_producto"),
    cantidad: entero(fila, "cantidad"),
    precio_unit: entero(fila, "precio_unit"),
  };
}

function idsUnicos(entidad: string, ids: string[], campo = "ids"): Set<string> {
  const unicos = new Set(ids);
  if (unicos.size !== ids.length) {
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new Error(`${entidad}: ${campo} repetidos ${[...new Set(repetidos)].join(", ")}`);
  }
  return unicos;
}
