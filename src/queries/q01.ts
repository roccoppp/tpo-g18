import type { ProductosRepository } from "../productos/repository.js";
import type { Producto } from "../productos/types.js";
import type { ProveedoresRepository } from "../proveedores/repository.js";
import type { Proveedor } from "../proveedores/types.js";

export type ProductoConProveedor = Producto & { proveedor: Proveedor | null };

export async function q01ProductosActivosConProveedor(
  productos: ProductosRepository,
  proveedores: ProveedoresRepository,
): Promise<ProductoConProveedor[]> {
  const activos = await productos.activos();
  const porId = await proveedores.obtenerVarios(activos.map((producto) => producto.id_proveedor));

  return activos.map((producto) => ({
    ...producto,
    proveedor: porId.get(producto.id_proveedor) ?? null,
  }));
}
