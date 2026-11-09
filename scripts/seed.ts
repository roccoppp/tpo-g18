// Carga idempotente: borra y vuelve a cargar cada entidad a partir de
// data/provistos y data/adicionales. Se puede ejecutar cuantas veces se quiera.

import { booleano, entero, fecha, leerDataset, requerido, unoDe, type Fila } from "../src/lib/csv.js";
import { connectMongo, connectNeo4j } from "../src/lib/db.js";
import { crearRepositorios } from "../src/lib/repositorios.js";
import type { Lote } from "../src/lotes/types.js";
import { CONDICIONES_VENTA, type Producto } from "../src/productos/types.js";
import { TIPOS_PROVEEDOR, type Proveedor } from "../src/proveedores/types.js";
import { TIPOS_SUCURSAL, type Sucursal } from "../src/sucursales/types.js";

// Los motores no validan referencias entre sí: se valida todo antes de escribir.
const proveedores = leerDataset("proveedores").map(proveedorDesdeFila);
const sucursales = leerDataset("sucursales").map(sucursalDesdeFila);
const productos = leerDataset("productos").map(productoDesdeFila);
const lotes = leerDataset("stock_lotes").map(loteDesdeFila);

const idsProveedor = idsUnicos("proveedores", proveedores.map((p) => p.id_proveedor));
const idsSucursal = idsUnicos("sucursales", sucursales.map((s) => s.id_sucursal));
const idsProducto = idsUnicos("productos", productos.map((p) => p._id));
idsUnicos("stock_lotes", lotes.map((l) => l._id));
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

function idsUnicos(entidad: string, ids: string[]): Set<string> {
  const unicos = new Set(ids);
  if (unicos.size !== ids.length) {
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new Error(`${entidad}: ids repetidos ${[...new Set(repetidos)].join(", ")}`);
  }
  return unicos;
}
