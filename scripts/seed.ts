// Carga idempotente: borra y vuelve a cargar cada entidad a partir de
// data/provistos y data/adicionales. Se puede ejecutar cuantas veces se quiera.

import { booleano, entero, leerDataset, requerido, unoDe, type Fila } from "../src/lib/csv.js";
import { connectMongo, connectRedis } from "../src/lib/db.js";
import { crearRepositorios } from "../src/lib/repositorios.js";
import { CONDICIONES_VENTA, type Producto } from "../src/productos/types.js";
import { TIPOS_PROVEEDOR, type Proveedor } from "../src/proveedores/types.js";

// Los motores no validan referencias entre sí: se valida todo antes de escribir.
const proveedores = leerDataset("proveedores").map(proveedorDesdeFila);
const productos = leerDataset("productos").map(productoDesdeFila);

const idsProveedor = idsUnicos("proveedores", proveedores.map((p) => p.id_proveedor));
idsUnicos("productos", productos.map((p) => p._id));
for (const producto of productos) {
  if (!idsProveedor.has(producto.id_proveedor)) {
    throw new Error(`Producto ${producto._id}: no existe el proveedor ${producto.id_proveedor}`);
  }
}

const mongo = await connectMongo();
const redis = await connectRedis();

try {
  const repos = crearRepositorios(mongo.db(), redis);

  await repos.proveedores.reemplazarTodos(proveedores);
  console.log(`Redis: ${proveedores.length} proveedores`);

  await repos.productos.reemplazarTodos(productos);
  console.log(`MongoDB: ${productos.length} productos`);
} finally {
  await redis.close();
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

function idsUnicos(entidad: string, ids: string[]): Set<string> {
  const unicos = new Set(ids);
  if (unicos.size !== ids.length) {
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new Error(`${entidad}: ids repetidos ${[...new Set(repetidos)].join(", ")}`);
  }
  return unicos;
}
